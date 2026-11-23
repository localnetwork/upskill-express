import { prisma } from "../../shared/database/prisma.js";
import { getPagination, toPagedResult } from "../../shared/utils/pagination.js";
import { activeEnrollmentFilter } from "../access/access.service.js";

function pickLatestMediaByTypes(mediaList = [], types = []) {
  return mediaList.find((item) => types.includes(item.mediaType)) || null;
}

function mapLegacyMedia(media) {
  if (!media) return null;
  return {
    id: media.id,
    path: media.storagePath,
    title: media.originalName,
  };
}

export async function listMyEnrollments(userId, query) {
  const { page, limit, skip } = getPagination(query);
  // Expired trial/subscription access must not appear in the learner's library.
  const where = { userId, ...activeEnrollmentFilter() };
  if (["ACTIVE", "COMPLETED"].includes(query.status)) where.status = query.status;
  const [rows, total] = await Promise.all([
    prisma.enrollment.findMany({
      where,
      skip,
      take: limit,
      select: {
        id: true,
        status: true,
        accessSource: true,
        accessEndsAt: true,
        enrolledAt: true,
        completedAt: true,
        course: {
          select: {
            id: true,
            slug: true,
            title: true,
            educator: {
              select: { id: true, username: true, fullName: true },
            },
            media: {
              where: {
                mediaType: { in: ["COVER_IMAGE", "IMAGE"] },
              },
              orderBy: { createdAt: "desc" },
              take: 5,
              select: {
                id: true,
                storagePath: true,
                originalName: true,
                mediaType: true,
              },
            },
            sections: {
              select: { _count: { select: { lessons: true } } },
            },
          },
        },
        courseProgress: {
          select: {
            totalLessons: true,
            completedLessons: true,
            progressPct: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.enrollment.count({ where }),
  ]);

  const mappedRows = rows.map((enrollment) => {
    const { media, sections, educator, ...courseFields } =
      enrollment.course || {};
    const coverImage = mapLegacyMedia(
      pickLatestMediaByTypes(media, ["COVER_IMAGE", "IMAGE"]),
    );
    const totalLessons =
      enrollment.courseProgress?.totalLessons ??
      sections?.reduce(
        (acc, section) => acc + (section._count?.lessons || 0),
        0,
      ) ??
      0;
    const completedLessons = enrollment.courseProgress?.completedLessons || 0;
    const progressPct = Number(enrollment.courseProgress?.progressPct || 0);
    const { courseProgress, ...enrollmentFields } = enrollment;

    return {
      ...enrollmentFields,
      course: {
        ...courseFields,
        educator,
        author: { data: educator },
        cover_image: coverImage,
      },
      progress: {
        progress_pct: progressPct,
        completed_lessons: completedLessons,
        total_lessons: totalLessons,
        completed: progressPct >= 100,
      },
      course_progress: {
        progress_pct: progressPct,
        completed_lessons: completedLessons,
        total_lessons: totalLessons,
      },
    };
  });

  return toPagedResult(mappedRows, total, page, limit);
}
