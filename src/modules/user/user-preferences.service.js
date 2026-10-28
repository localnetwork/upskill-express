import { ApiError } from "../../shared/utils/ApiError.js";
import { prisma } from "../../shared/database/prisma.js";

const MAX_INTERESTS = 50;

export async function getPreferenceOptions() {
  const [fields, topics] = await Promise.all([
    prisma.category.findMany({
      where: { parentId: null, deletedAt: null },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        slug: true,
        occupations: {
          where: { deletedAt: null },
          orderBy: { name: "asc" },
          select: { id: true, name: true },
        },
      },
    }),
    prisma.topic.findMany({
      where: { deletedAt: null, category: { deletedAt: null } },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        category: { select: { id: true, name: true, parentId: true } },
      },
    }),
  ]);

  return {
    fields: fields.map((field) => ({
      id: field.id,
      name: field.name,
      slug: field.slug,
      occupations: field.occupations,
    })),
    topics: topics.map((topic) => ({
      id: topic.id,
      name: topic.name,
      group_id: topic.category.id,
      group_name: topic.category.name,
      field_id: topic.category.parentId || topic.category.id,
    })),
  };
}

export async function getMyPreferences(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      deletedAt: true,
      occupationCustom: true,
      occupation: { select: { id: true, name: true, categoryId: true } },
      interests: { select: { topicId: true } },
    },
  });
  if (!user || user.deletedAt) throw new ApiError(404, "User not found");

  return {
    occupation: user.occupation
      ? {
          id: user.occupation.id,
          name: user.occupation.name,
          field_id: user.occupation.categoryId,
        }
      : null,
    occupation_custom: user.occupationCustom || "",
    topic_ids: user.interests.map((item) => item.topicId),
  };
}

export async function saveMyPreferences(userId, payload) {
  const occupationId = payload.occupationId || null;
  const occupationCustom = occupationId
    ? null
    : String(payload.occupationCustom || "").trim() || null;
  const requestedTopicIds = [...new Set(payload.topicIds || [])];

  if (requestedTopicIds.length > MAX_INTERESTS) {
    throw new ApiError(400, `You can select up to ${MAX_INTERESTS} skills`);
  }

  if (occupationId) {
    const occupation = await prisma.occupation.findFirst({
      where: { id: occupationId, deletedAt: null },
      select: { id: true },
    });
    if (!occupation) throw new ApiError(400, "Occupation not found");
  }

  const topics = requestedTopicIds.length
    ? await prisma.topic.findMany({
        where: { id: { in: requestedTopicIds }, deletedAt: null },
        select: { id: true },
      })
    : [];

  await prisma.$transaction([
    prisma.user.update({
      where: { id: userId },
      data: { occupationId, occupationCustom },
    }),
    prisma.userInterest.deleteMany({ where: { userId } }),
    prisma.userInterest.createMany({
      data: topics.map((topic) => ({ userId, topicId: topic.id })),
      skipDuplicates: true,
    }),
  ]);

  return getMyPreferences(userId);
}
