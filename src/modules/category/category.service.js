import { prisma } from "../../shared/database/prisma.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { getPagination, toPagedResult } from "../../shared/utils/pagination.js";
import { Prisma } from "@prisma/client";

const categoryModel = Prisma?.dmmf?.datamodel?.models?.find(
  (model) => model.name === "Category",
);
const categorySupportsImageField = Boolean(
  categoryModel?.fields?.some((field) => field.name === "image"),
);

let categoryImageColumnExistsCache = null;

function normalizeCategoryData(payload) {
  return {
    name: payload.name || payload.title,
    slug: payload.slug,
    description: payload.description || payload.category_description,
    parentId: payload.parentId || payload.parent_id || null,
  };
}

function normalizeCategoryImage(payload) {
  if (payload.image === undefined) return undefined;
  return String(payload.image || "").trim() || null;
}

function normalizeCategoryPayload(payload) {
  const data = normalizeCategoryData(payload);
  const normalizedImage = normalizeCategoryImage(payload);

  if (categorySupportsImageField && normalizedImage !== undefined) {
    data.image = normalizedImage;
  }

  return data;
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

async function categoryImageColumnExists() {
  if (categorySupportsImageField) return true;
  if (categoryImageColumnExistsCache !== null) return categoryImageColumnExistsCache;

  const result = await prisma.$queryRaw`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'categories'
        AND column_name = 'image'
    ) AS "exists"
  `;

  categoryImageColumnExistsCache = Boolean(result?.[0]?.exists);
  return categoryImageColumnExistsCache;
}

async function updateCategoryImageById(categoryId, image) {
  const hasImageColumn = await categoryImageColumnExists();
  if (!hasImageColumn) return;

  await prisma.$executeRaw`
    UPDATE "categories"
    SET "image" = ${image}, "updatedAt" = NOW()
    WHERE "id" = ${categoryId}
  `;
}

async function getCategoryImagesMap(categoryIds = []) {
  const uniqueIds = Array.from(new Set((categoryIds || []).filter(Boolean)));
  if (!uniqueIds.length) return new Map();

  const hasImageColumn = await categoryImageColumnExists();
  if (!hasImageColumn) return new Map();

  const rows = await prisma.$queryRaw`
    SELECT "id", "image"
    FROM "categories"
    WHERE "id" IN (${Prisma.join(uniqueIds)})
  `;

  return new Map(rows.map((row) => [row.id, row.image || null]));
}

function attachImagesToTree(nodes = [], imageMap = new Map()) {
  return (nodes || []).map((node) => ({
    ...node,
    image: imageMap.has(node.id) ? imageMap.get(node.id) : (node.image || null),
    children: attachImagesToTree(node.children || [], imageMap),
  }));
}

export async function createCategory(payload) {
  const image = normalizeCategoryImage(payload);
  const created = await prisma.category.create({ data: normalizeCategoryPayload(payload) });

  if (!categorySupportsImageField && image !== undefined) {
    await updateCategoryImageById(created.id, image);
    return { ...created, image };
  }

  return created;
}

export async function updateCategory(categoryId, payload) {
  const category = await prisma.category.findFirst({
    where: { id: categoryId, deletedAt: null },
  });
  if (!category) {
    throw new ApiError(404, "Category not found");
  }
  const image = normalizeCategoryImage(payload);

  const updated = await prisma.category.update({
    where: { id: categoryId },
    data: normalizeCategoryPayload(payload),
  });

  if (!categorySupportsImageField && image !== undefined) {
    await updateCategoryImageById(updated.id, image);
    return { ...updated, image };
  }

  return updated;
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
    let rows = await prisma.category.findMany({
      where: {
        deletedAt: null,
      },
      orderBy: [{ name: "asc" }, { createdAt: "asc" }],
    });

    if (!categorySupportsImageField && rows.length) {
      const imageMap = await getCategoryImagesMap(rows.map((row) => row.id));
      rows = rows.map((row) => ({
        ...row,
        image: imageMap.has(row.id) ? imageMap.get(row.id) : null,
      }));
    }

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
  let [rows, total] = await Promise.all([
    prisma.category.findMany({
      where,
      skip,
      take: limit,
      include: { parent: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.category.count({ where }),
  ]);

  if (!categorySupportsImageField && rows.length) {
    const rowIds = rows.map((row) => row.id);
    const parentIds = rows.map((row) => row.parent?.id).filter(Boolean);
    const imageMap = await getCategoryImagesMap([...rowIds, ...parentIds]);

    rows = rows.map((row) => ({
      ...row,
      image: imageMap.has(row.id) ? imageMap.get(row.id) : null,
      parent: row.parent
        ? {
            ...row.parent,
            image: imageMap.has(row.parent.id) ? imageMap.get(row.parent.id) : null,
          }
        : null,
    }));
  }

  return toPagedResult(rows, total, page, limit);
}

export async function getCategoryBySlugOrId(slugOrId) {
  let category = await prisma.category.findFirst({
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

  if (!categorySupportsImageField) {
    const childIds = (category.children || []).map((item) => item.id);
    const imageMap = await getCategoryImagesMap([
      category.id,
      category.parent?.id,
      ...childIds,
    ]);

    category = {
      ...category,
      image: imageMap.has(category.id) ? imageMap.get(category.id) : null,
      parent: category.parent
        ? {
            ...category.parent,
            image: imageMap.has(category.parent.id)
              ? imageMap.get(category.parent.id)
              : null,
          }
        : null,
      children: attachImagesToTree(category.children || [], imageMap),
    };
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
