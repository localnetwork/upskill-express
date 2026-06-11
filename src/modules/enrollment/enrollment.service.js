import { prisma } from "../../shared/database/prisma.js";
import { getPagination, toPagedResult } from "../../shared/utils/pagination.js";

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
  const where = {
    userId,
    status: query.status || undefined,
  };
  const [rows, total] = await Promise.all([
    prisma.enrollment.findMany({
      where,
      skip,
      take: limit,
      include: {
        course: {
          include: {
            educator: {
              select: { id: true, username: true, firstName: true, lastName: true },
            },
            media: {
              where: {
                mediaType: { in: ["COVER_IMAGE", "IMAGE"] },
              },
              orderBy: { createdAt: "desc" },
            },
            sections: {
              include: {
                lessons: true,
              },
            },
          },
        },
        courseProgress: true,
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.enrollment.count({ where }),
  ]);

  const mappedRows = rows.map((enrollment) => {
    const coverImage = mapLegacyMedia(
      pickLatestMediaByTypes(enrollment.course?.media, ["COVER_IMAGE", "IMAGE"]),
    );
    const totalLessons =
      enrollment.courseProgress?.totalLessons ??
      enrollment.course?.sections?.reduce(
        (acc, section) => acc + (section.lessons?.length || 0),
        0,
      ) ??
      0;
    const completedLessons = enrollment.courseProgress?.completedLessons || 0;
    const progressPct = Number(enrollment.courseProgress?.progressPct || 0);

    return {
      ...enrollment,
      course: {
        ...enrollment.course,
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
