import { prisma } from "../../shared/database/prisma.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { getPagination, toPagedResult } from "../../shared/utils/pagination.js";

function wishlistModel() {
  if (!prisma.wishlist) {
    throw new ApiError(
      500,
      "Wishlist model is unavailable. Regenerate Prisma client and restart the backend.",
    );
  }
  return prisma.wishlist;
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

function mapWishlistItem(row) {
  const coverImage = mapLegacyMedia(
    pickLatestMediaByTypes(row.course?.media, ["COVER_IMAGE", "IMAGE"]),
  );

  return {
    id: row.id,
    course_id: row.courseId,
    created_at: row.createdAt,
    course: {
      id: row.course.id,
      slug: row.course.slug,
      title: row.course.title,
      subtitle: row.course.subtitle,
      cover_image: coverImage,
      price_tier: row.course.priceTier
        ? {
            id: row.course.priceTier.id,
            title: row.course.priceTier.title,
            price: String(row.course.priceTier.price),
          }
        : null,
      educator: row.course.educator,
      author: {
        data: {
          id: row.course.educator?.id,
          username: row.course.educator?.username,
          firstname: row.course.educator?.firstName || "",
          lastname: row.course.educator?.lastName || "",
          user_picture: null,
        },
      },
      is_in_wishlist: true,
    },
  };
}

export async function listWishlist(userId, query) {
  const { page, limit, skip } = getPagination(query);
  const where = { userId };
  const wishlist = wishlistModel();

  const [rows, total] = await Promise.all([
    wishlist.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        course: {
          include: {
            educator: {
              select: { id: true, username: true, firstName: true, lastName: true },
            },
            priceTier: true,
            media: {
              where: {
                mediaType: { in: ["COVER_IMAGE", "IMAGE"] },
              },
              orderBy: { createdAt: "desc" },
            },
          },
        },
      },
    }),
    wishlist.count({ where }),
  ]);

  return toPagedResult(rows.map(mapWishlistItem), total, page, limit);
}

export async function addToWishlist(userId, courseId) {
  const course = await prisma.course.findFirst({
    where: {
      id: courseId,
      deletedAt: null,
      OR: [{ workflowStatus: "PUBLISHED" }, { isPublished: true }],
    },
  });

  if (!course) {
    throw new ApiError(404, "Course not found");
  }

  const wishlist = wishlistModel();
  await wishlist.upsert({
    where: {
      userId_courseId: { userId, courseId },
    },
    create: { userId, courseId },
    update: {},
  });

  return { success: true };
}

export async function removeFromWishlist(userId, courseId) {
  const wishlist = wishlistModel();
  const deleted = await wishlist.deleteMany({
    where: { userId, courseId },
  });

  if (!deleted.count) {
    throw new ApiError(404, "Course not found in wishlist");
  }

  return { success: true };
}
