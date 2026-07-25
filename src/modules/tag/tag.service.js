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
  return toLegacyTag(tag);
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
