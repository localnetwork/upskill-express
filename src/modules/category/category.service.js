import { prisma } from "../../shared/database/prisma.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { getPagination, toPagedResult } from "../../shared/utils/pagination.js";

function normalizeCategoryPayload(payload) {
  return {
    name: payload.name || payload.title,
    slug: payload.slug,
    description: payload.description || payload.category_description,
    parentId: payload.parentId || payload.parent_id || null,
  };
}

export async function createCategory(payload) {
  return prisma.category.create({ data: normalizeCategoryPayload(payload) });
}

export async function updateCategory(categoryId, payload) {
  const category = await prisma.category.findFirst({
    where: { id: categoryId, deletedAt: null },
  });
  if (!category) {
    throw new ApiError(404, "Category not found");
  }
  return prisma.category.update({
    where: { id: categoryId },
    data: normalizeCategoryPayload(payload),
  });
}

export async function listCategories(query) {
  const { page, limit, skip } = getPagination(query);
  const where = {
    deletedAt: null,
    OR: query.search
      ? [
          { name: { contains: query.search, mode: "insensitive" } },
          { slug: { contains: query.search, mode: "insensitive" } },
        ]
      : undefined,
  };
  const [rows, total] = await Promise.all([
    prisma.category.findMany({
      where,
      skip,
      take: limit,
      include: { parent: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.category.count({ where }),
  ]);
  return toPagedResult(rows, total, page, limit);
}

export async function deleteCategory(categoryId) {
  const category = await prisma.category.findFirst({
    where: { id: categoryId, deletedAt: null },
  });
  if (!category) {
    throw new ApiError(404, "Category not found");
  }
  await prisma.category.update({
    where: { id: categoryId },
    data: { deletedAt: new Date() },
  });
  return { success: true };
}
