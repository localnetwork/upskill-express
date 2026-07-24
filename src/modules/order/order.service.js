import { prisma } from "../../shared/database/prisma.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { getPagination, toPagedResult } from "../../shared/utils/pagination.js";

const ALLOWED_ORDER_STATUSES = new Set([
  "CREATED",
  "PAID",
  "FAILED",
  "REFUNDED",
  "CANCELLED",
]);
const COURSE_COVER_MEDIA_TYPES = ["COVER_IMAGE", "IMAGE"];

function toTrimmed(value) {
  return String(value || "").trim();
}

function normalizeSort(rawSort) {
  const normalized = toTrimmed(rawSort).toLowerCase();
  if (normalized === "oldest") return "oldest";
  if (normalized === "amount_asc") return "amount_asc";
  if (normalized === "amount_desc") return "amount_desc";
  return "recent";
}

function buildOrderBy(sort) {
  if (sort === "oldest") return [{ createdAt: "asc" }];
  if (sort === "amount_asc") return [{ totalAmount: "asc" }, { createdAt: "desc" }];
  if (sort === "amount_desc") return [{ totalAmount: "desc" }, { createdAt: "desc" }];
  return [{ createdAt: "desc" }];
}

function buildOrderWhere(userId, query = {}, options = {}) {
  const status = toTrimmed(query.status).toUpperCase();
  const q = toTrimmed(query.q || query.search).slice(0, 120);
  const authorId = toTrimmed(query.authorId || query.author).slice(0, 120);
  const { excludeAuthor = false } = options;

  const where = { userId };
  const andClauses = [];

  if (ALLOWED_ORDER_STATUSES.has(status)) {
    andClauses.push({ status });
  }

  if (!excludeAuthor && authorId) {
    andClauses.push({
      items: {
        some: {
          educatorId: authorId,
        },
      },
    });
  }

  if (q) {
    andClauses.push({
      OR: [
        { id: { contains: q, mode: "insensitive" } },
        {
          items: {
            some: {
              course: {
                title: { contains: q, mode: "insensitive" },
              },
            },
          },
        },
      ],
    });
  }

  if (andClauses.length > 0) {
    where.AND = andClauses;
  }

  return where;
}

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

function mapOrderItemCourse(item) {
  const media = Array.isArray(item?.course?.media) ? item.course.media : [];
  const coverImage = mapLegacyMedia(
    pickLatestMediaByTypes(media, COURSE_COVER_MEDIA_TYPES),
  );

  return {
    ...item,
    course: item?.course
      ? {
          ...item.course,
          cover_image: coverImage,
        }
      : item?.course,
  };
}

function mapOrderWithCourseImages(order) {
  const items = Array.isArray(order?.items) ? order.items.map(mapOrderItemCourse) : [];
  return {
    ...order,
    items,
  };
}

export async function listMyOrders(userId, query) {
  const { page, limit, skip } = getPagination(query);
  const sort = normalizeSort(query?.sort);
  const where = buildOrderWhere(userId, query);
  const authorFacetWhere = buildOrderWhere(userId, query, { excludeAuthor: true });

  const [rows, total] = await Promise.all([
    prisma.order.findMany({
      where,
      skip,
      take: limit,
      include: {
        items: {
          include: {
            course: {
              select: {
                id: true,
                title: true,
                slug: true,
                educatorId: true,
                media: {
                  where: {
                    mediaType: { in: COURSE_COVER_MEDIA_TYPES },
                  },
                  orderBy: { createdAt: "desc" },
                  take: 1,
                },
                educator: {
                  select: {
                    id: true,
                    firstName: true,
                    lastName: true,
                    username: true,
                  },
                },
              },
            },
            educator: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                username: true,
              },
            },
          },
        },
        payment: true,
      },
      orderBy: buildOrderBy(sort),
    }),
    prisma.order.count({ where }),
  ]);

  const authorRows = await prisma.orderItem.findMany({
    where: {
      order: authorFacetWhere,
    },
    select: {
      educatorId: true,
      educator: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          username: true,
        },
      },
    },
    distinct: ["educatorId"],
  });

  const authors = authorRows
    .map((row) => {
      const firstName = row?.educator?.firstName || "";
      const lastName = row?.educator?.lastName || "";
      const displayName = `${firstName} ${lastName}`.trim() || row?.educator?.username || "Unknown author";
      return {
        id: row.educatorId,
        name: displayName,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  const paged = toPagedResult(
    rows.map(mapOrderWithCourseImages),
    total,
    page,
    limit,
  );
  return {
    ...paged,
    filters: {
      authors,
      statuses: Array.from(ALLOWED_ORDER_STATUSES.values()),
      sorts: ["recent", "oldest", "amount_desc", "amount_asc"],
    },
  };
}

export async function getMyOrder(userId, orderId) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, userId },
    include: {
      items: {
        include: {
          course: {
            include: {
              media: {
                where: {
                  mediaType: { in: COURSE_COVER_MEDIA_TYPES },
                },
                orderBy: { createdAt: "desc" },
                take: 1,
              },
              educator: {
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                  username: true,
                },
              },
            },
          },
        },
      },
      payment: true,
      taxTransaction: true,
    },
  });
  if (!order) {
    throw new ApiError(404, "Order not found");
  }
  return mapOrderWithCourseImages(order);
}
