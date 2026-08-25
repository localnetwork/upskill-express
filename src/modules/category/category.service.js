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
const categorySupportsIconField = Boolean(
  categoryModel?.fields?.some((field) => field.name === "icon"),
);
const categorySupportsColorField = Boolean(
  categoryModel?.fields?.some((field) => field.name === "color"),
);

let categoryImageColumnExistsCache = null;
let categoryIconColumnExistsCache = null;
let categoryColorColumnExistsCache = null;

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

function normalizeCategoryIcon(payload) {
  if (payload.icon === undefined) return undefined;
  return String(payload.icon || "").trim() || null;
}

function normalizeCategoryColor(payload) {
  if (payload.color === undefined) return undefined;
  return String(payload.color || "").trim() || null;
}

function normalizeCategoryPayload(payload) {
  const data = normalizeCategoryData(payload);
  const normalizedImage = normalizeCategoryImage(payload);
  const normalizedIcon = normalizeCategoryIcon(payload);
  const normalizedColor = normalizeCategoryColor(payload);

  if (categorySupportsImageField && normalizedImage !== undefined) {
    data.image = normalizedImage;
  }
  if (categorySupportsIconField && normalizedIcon !== undefined) {
    data.icon = normalizedIcon;
  }
  if (categorySupportsColorField && normalizedColor !== undefined) {
    data.color = normalizedColor;
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

async function categoryIconColumnExists() {
  if (categorySupportsIconField) return true;
  if (categoryIconColumnExistsCache !== null) return categoryIconColumnExistsCache;

  const result = await prisma.$queryRaw`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'categories'
        AND column_name = 'icon'
    ) AS "exists"
  `;

  categoryIconColumnExistsCache = Boolean(result?.[0]?.exists);
  return categoryIconColumnExistsCache;
}

async function categoryColorColumnExists() {
  if (categorySupportsColorField) return true;
  if (categoryColorColumnExistsCache !== null) return categoryColorColumnExistsCache;

  const result = await prisma.$queryRaw`
    SELECT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'categories'
        AND column_name = 'color'
    ) AS "exists"
  `;

  categoryColorColumnExistsCache = Boolean(result?.[0]?.exists);
  return categoryColorColumnExistsCache;
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

async function updateCategoryIconById(categoryId, icon) {
  const hasIconColumn = await categoryIconColumnExists();
  if (!hasIconColumn) return;

  await prisma.$executeRaw`
    UPDATE "categories"
    SET "icon" = ${icon}, "updatedAt" = NOW()
    WHERE "id" = ${categoryId}
  `;
}

async function updateCategoryColorById(categoryId, color) {
  const hasColorColumn = await categoryColorColumnExists();
  if (!hasColorColumn) return;

  await prisma.$executeRaw`
    UPDATE "categories"
    SET "color" = ${color}, "updatedAt" = NOW()
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

function attachCategoryMetaToTree(
  nodes = [],
  imageMap = new Map(),
  iconMap = new Map(),
  colorMap = new Map(),
) {
  return (nodes || []).map((node) => ({
    ...withCategoryMeta(node, imageMap, iconMap, colorMap),
    children: attachCategoryMetaToTree(
      node.children || [],
      imageMap,
      iconMap,
      colorMap,
    ),
  }));
}

async function getCategoryMetaMaps(categoryIds = []) {
  const uniqueIds = Array.from(new Set((categoryIds || []).filter(Boolean)));
  if (!uniqueIds.length) {
    return {
      imageMap: new Map(),
      iconMap: new Map(),
      colorMap: new Map(),
    };
  }

  const [hasImageColumn, hasIconColumn, hasColorColumn] = await Promise.all([
    categoryImageColumnExists(),
    categoryIconColumnExists(),
    categoryColorColumnExists(),
  ]);

  if (!hasImageColumn && !hasIconColumn && !hasColorColumn) {
    return {
      imageMap: new Map(),
      iconMap: new Map(),
      colorMap: new Map(),
    };
  }

  const imageMap = new Map();
  const iconMap = new Map();
  const colorMap = new Map();

  if (hasImageColumn) {
    const imageRows = await prisma.$queryRaw`
      SELECT "id", "image"
      FROM "categories"
      WHERE "id" IN (${Prisma.join(uniqueIds)})
    `;
    for (const row of imageRows) imageMap.set(row.id, row.image || null);
  }

  if (hasIconColumn) {
    const iconRows = await prisma.$queryRaw`
      SELECT "id", "icon"
      FROM "categories"
      WHERE "id" IN (${Prisma.join(uniqueIds)})
    `;
    for (const row of iconRows) iconMap.set(row.id, row.icon || null);
  }

  if (hasColorColumn) {
    const colorRows = await prisma.$queryRaw`
      SELECT "id", "color"
      FROM "categories"
      WHERE "id" IN (${Prisma.join(uniqueIds)})
    `;
    for (const row of colorRows) colorMap.set(row.id, row.color || null);
  }

  return { imageMap, iconMap, colorMap };
}

function withCategoryMeta(row, imageMap, iconMap, colorMap) {
  return {
    ...row,
    image: imageMap.has(row.id) ? imageMap.get(row.id) : row.image || null,
    icon: iconMap.has(row.id) ? iconMap.get(row.id) : row.icon || null,
    color: colorMap.has(row.id) ? colorMap.get(row.id) : row.color || null,
  };
}

export async function createCategory(payload) {
  const image = normalizeCategoryImage(payload);
  const icon = normalizeCategoryIcon(payload);
  const color = normalizeCategoryColor(payload);
  const created = await prisma.category.create({ data: normalizeCategoryPayload(payload) });

  if (!categorySupportsImageField && image !== undefined) {
    await updateCategoryImageById(created.id, image);
  }
  if (!categorySupportsIconField && icon !== undefined) {
    await updateCategoryIconById(created.id, icon);
  }
  if (!categorySupportsColorField && color !== undefined) {
    await updateCategoryColorById(created.id, color);
  }

  if (
    (!categorySupportsImageField && image !== undefined) ||
    (!categorySupportsIconField && icon !== undefined) ||
    (!categorySupportsColorField && color !== undefined)
  ) {
    return { ...created, image: image ?? null, icon: icon ?? null, color: color ?? null };
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
  const icon = normalizeCategoryIcon(payload);
  const color = normalizeCategoryColor(payload);

  const updated = await prisma.category.update({
    where: { id: categoryId },
    data: normalizeCategoryPayload(payload),
  });

  if (!categorySupportsImageField && image !== undefined) {
    await updateCategoryImageById(updated.id, image);
  }
  if (!categorySupportsIconField && icon !== undefined) {
    await updateCategoryIconById(updated.id, icon);
  }
  if (!categorySupportsColorField && color !== undefined) {
    await updateCategoryColorById(updated.id, color);
  }

  if (
    (!categorySupportsImageField && image !== undefined) ||
    (!categorySupportsIconField && icon !== undefined) ||
    (!categorySupportsColorField && color !== undefined)
  ) {
    return { ...updated, image: image ?? null, icon: icon ?? null, color: color ?? null };
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

    if ((!categorySupportsImageField || !categorySupportsIconField || !categorySupportsColorField) && rows.length) {
      const { imageMap, iconMap, colorMap } = await getCategoryMetaMaps(rows.map((row) => row.id));
      rows = rows.map((row) => withCategoryMeta(row, imageMap, iconMap, colorMap));
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

  if ((!categorySupportsImageField || !categorySupportsIconField || !categorySupportsColorField) && rows.length) {
    const rowIds = rows.map((row) => row.id);
    const parentIds = rows.map((row) => row.parent?.id).filter(Boolean);
    const { imageMap, iconMap, colorMap } = await getCategoryMetaMaps([...rowIds, ...parentIds]);

    rows = rows.map((row) => ({
      ...withCategoryMeta(row, imageMap, iconMap, colorMap),
      parent: row.parent
        ? {
            ...withCategoryMeta(row.parent, imageMap, iconMap, colorMap),
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

  if (!categorySupportsImageField || !categorySupportsIconField || !categorySupportsColorField) {
    const childIds = (category.children || []).map((item) => item.id);
    const { imageMap, iconMap, colorMap } = await getCategoryMetaMaps([
      category.id,
      category.parent?.id,
      ...childIds,
    ]);

    category = {
      ...withCategoryMeta(category, imageMap, iconMap, colorMap),
      parent: category.parent
        ? {
            ...withCategoryMeta(category.parent, imageMap, iconMap, colorMap),
          }
        : null,
      children: attachCategoryMetaToTree(
        category.children || [],
        imageMap,
        iconMap,
        colorMap,
      ),
    };
  }

  const categoryIds = [
    category.id,
    ...(Array.isArray(category.children)
      ? category.children.map((child) => child.id).filter(Boolean)
      : []),
  ];

  const publishedCourses = await prisma.course.findMany({
    where: {
      deletedAt: null,
      workflowStatus: "PUBLISHED",
      categoryId: { in: categoryIds },
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
  });

  const courseIds = publishedCourses.map((course) => course.id);
  const enrollmentsByCourseId = new Map();
  const ratingsByCourseId = new Map();

  if (courseIds.length) {
    const [enrollmentRows, ratingRows] = await Promise.all([
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

    for (const row of enrollmentRows) {
      enrollmentsByCourseId.set(row.courseId, Number(row?._count?._all || 0));
    }
    for (const row of ratingRows) {
      ratingsByCourseId.set(row.courseId, {
        average: Number(row?._avg?.rating || 0),
        count: Number(row?._count?.rating || 0),
      });
    }
  }

  const educatorMap = new Map();
  for (const course of publishedCourses) {
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
      const displayName = `${row.first_name} ${row.last_name}`.trim() || row.username || "Educator";
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
  const expertCourses = publishedCourses.length;

  category = {
    ...category,
    expert_courses: expertCourses,
    total_enrolled: totalEnrolled,
    popular_educators: popularEducators.map((row) => ({
      ...row,
      profile_picture: profilePicturesByUserId.get(row.id) || null,
    })),
  };

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
