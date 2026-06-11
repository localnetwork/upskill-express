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

function toLegacyCategory(category) {
  return {
    ...category,
    title: category.name || category.title,
    category_description: category.description || category.category_description || null,
    parent_id: category.parentId || category.parent_id || null,
    children: (category.children || []).map(toLegacyCategory),
  };
}

function buildCategoryTree(categories) {
  const normalized = categories.map((category) => ({
    ...toLegacyCategory(category),
    children: [],
  }));

  const byId = new Map(normalized.map((category) => [category.id, category]));
  const roots = [];

  for (const category of normalized) {
    if (category.parentId && byId.has(category.parentId)) {
      byId.get(category.parentId).children.push(category);
    } else {
      roots.push(category);
    }
  }

  return roots;
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
  const shouldReturnTree =
    query.tree === "true" ||
    query.hierarchy === "true" ||
    query.view === "tree";

  const parentId =
    query.parentId === undefined
      ? query.parent_id
      : query.parentId;

  const where = {
    deletedAt: null,
    parentId:
      parentId === undefined || parentId === null || parentId === ""
        ? undefined
        : parentId,
    OR: query.search
      ? [
          { name: { contains: query.search, mode: "insensitive" } },
          { slug: { contains: query.search, mode: "insensitive" } },
        ]
      : undefined,
  };

  if (shouldReturnTree) {
    const rows = await prisma.category.findMany({
      where: {
        deletedAt: null,
      },
      orderBy: [{ name: "asc" }, { createdAt: "asc" }],
    });

    const tree = buildCategoryTree(rows);
    const total = rows.length;
    return {
      data: tree,
      meta: {
        total,
        page: 1,
        limit: total,
        totalPages: 1,
      },
      pagination: {
        total,
        page: 1,
        limit: total,
        totalPages: 1,
      },
    };
  }

  const { page, limit, skip } = getPagination(query);
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

export async function getCategoryBySlugOrId(slugOrId) {
  const category = await prisma.category.findFirst({
    where: {
      deletedAt: null,
      OR: [{ id: slugOrId }, { slug: slugOrId }],
    },
    include: {
      parent: true,
      children: {
        where: { deletedAt: null },
        orderBy: { name: "asc" },
      },
    },
  });

  if (!category) {
    throw new ApiError(404, "Category not found");
  }

  return toLegacyCategory(category);
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
