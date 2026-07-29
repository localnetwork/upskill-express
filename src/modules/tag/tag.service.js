import { prisma } from "../../shared/database/prisma.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { getPagination, toPagedResult } from "../../shared/utils/pagination.js";

function normalizeTagPayload(payload) {
  return {
    name: payload.name || payload.title,
    slug: payload.slug,
    description: payload.description || null,
    categoryId: payload.categoryId || payload.category_id,
  };
}

function toLegacyTag(tag) {
  return {
    ...tag,
    title: tag.name || tag.title,
    category_id: tag.categoryId || tag.category_id || null,
  };
}

async function attachCourseCounts(rows = []) {
  const topicIds = rows.map((row) => row.id).filter(Boolean);
  if (!topicIds.length) return rows;

  const [directLessons, mappedLessons] = await Promise.all([
    prisma.lesson.findMany({
      where: {
        topicId: { in: topicIds },
        course: {
          deletedAt: null,
          workflowStatus: "PUBLISHED",
        },
      },
      select: { topicId: true, courseId: true },
    }),
    prisma.lessonTopic.findMany({
      where: {
        topicId: { in: topicIds },
        lesson: {
          course: {
            deletedAt: null,
            workflowStatus: "PUBLISHED",
          },
        },
      },
      select: {
        topicId: true,
        lesson: {
          select: { courseId: true },
        },
      },
    }),
  ]);

  const courseSetByTopicId = new Map(topicIds.map((topicId) => [topicId, new Set()]));

  for (const lesson of directLessons) {
    if (!lesson?.topicId || !lesson?.courseId) continue;
    courseSetByTopicId.get(lesson.topicId)?.add(lesson.courseId);
  }

  for (const row of mappedLessons) {
    const topicId = row?.topicId;
    const courseId = row?.lesson?.courseId;
    if (!topicId || !courseId) continue;
    courseSetByTopicId.get(topicId)?.add(courseId);
  }

  return rows.map((row) => ({
    ...row,
    course_count: courseSetByTopicId.get(row.id)?.size || 0,
  }));
}

export async function createTag(payload) {
  return prisma.topic.create({
    data: normalizeTagPayload(payload),
    include: { category: true },
  });
}

export async function updateTag(tagId, payload) {
  const tag = await prisma.topic.findFirst({
    where: { id: tagId, deletedAt: null },
  });
  if (!tag) {
    throw new ApiError(404, "Tag not found");
  }
  return prisma.topic.update({
    where: { id: tagId },
    data: normalizeTagPayload(payload),
    include: { category: true },
  });
}

export async function listTags(query) {
  const categoryId =
    query.categoryId === undefined ? query.category_id : query.categoryId;

  const where = {
    deletedAt: null,
    categoryId:
      categoryId === undefined || categoryId === null || categoryId === ""
        ? undefined
        : categoryId,
    OR: query.search
      ? [
          { name: { contains: query.search, mode: "insensitive" } },
          { slug: { contains: query.search, mode: "insensitive" } },
        ]
      : undefined,
  };

  const { page, limit, skip } = getPagination(query);
  const [rows, total] = await Promise.all([
    prisma.topic.findMany({
      where,
      skip,
      take: limit,
      include: { category: true },
      orderBy: [{ name: "asc" }, { createdAt: "desc" }],
    }),
    prisma.topic.count({ where }),
  ]);

  const rowsWithCounts = await attachCourseCounts(rows);
  return toPagedResult(rowsWithCounts, total, page, limit);
}

export async function getTagBySlugOrId(slugOrId) {
  const tag = await prisma.topic.findFirst({
    where: {
      deletedAt: null,
      OR: [{ id: slugOrId }, { slug: slugOrId }],
    },
    include: { category: true },
  });
  if (!tag) {
    throw new ApiError(404, "Tag not found");
  }

  const [directLessons, mappedLessons] = await Promise.all([
    prisma.lesson.findMany({
      where: {
        topicId: tag.id,
        course: {
          deletedAt: null,
          workflowStatus: "PUBLISHED",
        },
      },
      select: { courseId: true },
    }),
    prisma.lessonTopic.findMany({
      where: {
        topicId: tag.id,
        lesson: {
          course: {
            deletedAt: null,
            workflowStatus: "PUBLISHED",
          },
        },
      },
      select: {
        lesson: {
          select: { courseId: true },
        },
      },
    }),
  ]);

  const courseIds = Array.from(
    new Set([
      ...directLessons.map((row) => row.courseId).filter(Boolean),
      ...mappedLessons.map((row) => row?.lesson?.courseId).filter(Boolean),
    ]),
  );

  if (!courseIds.length) {
    return toLegacyTag({
      ...tag,
      expert_courses: 0,
      total_enrolled: 0,
      popular_educators: [],
    });
  }

  const [courses, enrollmentRows, ratingRows] = await Promise.all([
    prisma.course.findMany({
      where: {
        id: { in: courseIds },
        deletedAt: null,
        workflowStatus: "PUBLISHED",
      },
      select: {
        id: true,
        educatorId: true,
        educator: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            headline: true,
          },
        },
      },
    }),
    prisma.enrollment.groupBy({
      by: ["courseId"],
      where: {
        courseId: { in: courseIds },
        status: { in: ["ACTIVE", "COMPLETED"] },
      },
      _count: { _all: true },
    }),
    prisma.review.groupBy({
      by: ["courseId"],
      where: {
        courseId: { in: courseIds },
      },
      _avg: { rating: true },
      _count: { rating: true },
    }),
  ]);

  const enrollmentsByCourseId = new Map(
    enrollmentRows.map((row) => [row.courseId, Number(row?._count?._all || 0)]),
  );
  const ratingsByCourseId = new Map(
    ratingRows.map((row) => [
      row.courseId,
      {
        average: Number(row?._avg?.rating || 0),
        count: Number(row?._count?.rating || 0),
      },
    ]),
  );

  const educatorMap = new Map();
  for (const course of courses) {
    if (!course?.educator?.id) continue;
    if (!educatorMap.has(course.educator.id)) {
      educatorMap.set(course.educator.id, {
        id: course.educator.id,
        username: course.educator.username || "",
        first_name: course.educator.firstName || "",
        last_name: course.educator.lastName || "",
        headline: course.educator.headline || "",
        courses_count: 0,
        total_enrollees: 0,
        total_reviews: 0,
        weighted_rating_sum: 0,
      });
    }

    const row = educatorMap.get(course.educator.id);
    row.courses_count += 1;
    row.total_enrollees += Number(enrollmentsByCourseId.get(course.id) || 0);

    const ratingMeta = ratingsByCourseId.get(course.id) || { average: 0, count: 0 };
    row.total_reviews += Number(ratingMeta.count || 0);
    row.weighted_rating_sum +=
      Number(ratingMeta.average || 0) * Number(ratingMeta.count || 0);
  }

  const popularEducators = Array.from(educatorMap.values())
    .map((row) => {
      const displayName =
        `${row.first_name} ${row.last_name}`.trim() || row.username || "Educator";
      const averageRating = row.total_reviews
        ? Number((row.weighted_rating_sum / row.total_reviews).toFixed(2))
        : 0;

      return {
        id: row.id,
        username: row.username,
        display_name: displayName,
        headline: row.headline,
        courses_count: row.courses_count,
        total_enrollees: row.total_enrollees,
        average_rating: averageRating,
        total_reviews: row.total_reviews,
      };
    })
    .sort((a, b) => {
      if (b.total_enrollees !== a.total_enrollees) {
        return b.total_enrollees - a.total_enrollees;
      }
      if (b.average_rating !== a.average_rating) {
        return b.average_rating - a.average_rating;
      }
      return b.courses_count - a.courses_count;
    })
    .slice(0, 5);

  const educatorIds = popularEducators.map((row) => row.id);
  const profilePicturesByUserId = new Map();

  if (educatorIds.length) {
    const mediaRows = await prisma.media.findMany({
      where: {
        userId: { in: educatorIds },
        courseId: null,
        mediaType: "IMAGE",
      },
      select: {
        id: true,
        userId: true,
        storagePath: true,
      },
      orderBy: { createdAt: "desc" },
    });

    for (const row of mediaRows) {
      if (!profilePicturesByUserId.has(row.userId)) {
        profilePicturesByUserId.set(row.userId, {
          id: row.id,
          path: row.storagePath,
        });
      }
    }
  }

  const totalEnrolled = courseIds.reduce(
    (sum, courseId) => sum + Number(enrollmentsByCourseId.get(courseId) || 0),
    0,
  );

  return toLegacyTag({
    ...tag,
    expert_courses: courses.length,
    total_enrolled: totalEnrolled,
    popular_educators: popularEducators.map((row) => ({
      ...row,
      profile_picture: profilePicturesByUserId.get(row.id) || null,
    })),
  });
}

export async function deleteTag(tagId) {
  const tag = await prisma.topic.findFirst({
    where: { id: tagId, deletedAt: null },
  });
  if (!tag) {
    throw new ApiError(404, "Tag not found");
  }
  await prisma.topic.update({
    where: { id: tagId },
    data: { deletedAt: new Date() },
  });
  return { success: true };
}

export function mapLegacyTagResult(pagedResult) {
  return {
    ...pagedResult,
    data: (pagedResult.data || []).map((row) => toLegacyTag(row)),
  };
}
