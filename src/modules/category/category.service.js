import { prisma } from "../../shared/database/prisma.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { getPagination, toPagedResult } from "../../shared/utils/pagination.js";

export async function createCategory(payload) {
  return prisma.category.create({ data: payload });
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
    data: payload,
  });
}

export async function listCategories(query) {
  const { page, limit, skip } = getPagination(query);
  const where = {
    deletedAt: null,
    name: query.search
      ? { contains: query.search, mode: "insensitive" }
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
