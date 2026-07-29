import { prisma } from "../../shared/database/prisma.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { recordActivityEvent } from "../analytics/analytics.service.js";

async function getOrCreateCart(userId) {
  const cart = await prisma.cart.findUnique({ where: { userId } });
  if (cart) return cart;
  return prisma.cart.create({ data: { userId } });
}

function decimal(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function calculateDiscountForSubtotal(coupon, subtotal) {
  if (!coupon) return 0;
  const safeSubtotal = decimal(subtotal);
  if (safeSubtotal <= 0) return 0;

  if (coupon.type === "PERCENTAGE") {
    const pctDiscount = (safeSubtotal * decimal(coupon.value)) / 100;
    if (!coupon.maxDiscount) return Number(pctDiscount.toFixed(2));
    return Number(Math.min(pctDiscount, decimal(coupon.maxDiscount)).toFixed(2));
  }

  return Number(Math.min(safeSubtotal, decimal(coupon.value)).toFixed(2));
}

async function resolveActiveCouponForCart(code, courseIds) {
  const normalizedCode = String(code || "").trim().toUpperCase();
  if (!normalizedCode) {
    throw new ApiError(400, "Coupon code is required");
  }

  const coupon = await prisma.coupon.findFirst({
    where: {
      code: {
        equals: normalizedCode,
        mode: "insensitive",
      },
      isActive: true,
      deletedAt: null,
      OR: [{ startsAt: null }, { startsAt: { lte: new Date() } }],
      AND: [{ OR: [{ endsAt: null }, { endsAt: { gte: new Date() } }] }],
    },
  });

  if (!coupon) {
    throw new ApiError(400, "Invalid coupon");
  }
  if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) {
    throw new ApiError(400, "Coupon usage limit reached");
  }
  if (coupon.courseId && !courseIds.includes(coupon.courseId)) {
    throw new ApiError(400, "Coupon is not valid for items in your cart");
  }
  return coupon;
}

export async function getCart(userId) {
  const cart = await getOrCreateCart(userId);
  return prisma.cart.findUnique({
    where: { id: cart.id },
    include: {
      items: {
        include: {
          course: {
            include: {
              priceTier: true,
              media: {
                where: {
                  mediaType: { in: ["COVER_IMAGE", "IMAGE", "PROMO_VIDEO"] },
                },
                orderBy: { createdAt: "desc" },
              },
              educator: {
                select: {
                  id: true,
                  username: true,
                  firstName: true,
                  lastName: true,
                },
              },
            },
          },
        },
      },
    },
  });
}

export async function addToCart(userId, courseId) {
  const [cart, course, existingEnrollment] = await Promise.all([
    getOrCreateCart(userId),
    prisma.course.findFirst({
      where: {
        id: courseId,
        deletedAt: null,
        OR: [{ workflowStatus: "PUBLISHED" }, { isPublished: true }],
      },
    }),
    prisma.enrollment.findFirst({
      where: { userId, courseId },
    }),
  ]);

  if (!course) {
    throw new ApiError(404, "Course not found");
  }
  if (existingEnrollment) {
    throw new ApiError(400, "You already own this course");
  }

  await prisma.cartItem.upsert({
    where: {
      cartId_courseId: {
        cartId: cart.id,
        courseId,
      },
    },
    update: {},
    create: {
      cartId: cart.id,
      courseId,
    },
  });

  await recordActivityEvent({
    eventType: "COMMERCE_CART_ADD",
    userId,
    courseId,
    pagePath: "/cart",
    dedupeWindowSeconds: 5,
  });

  return getCart(userId);
}

export async function removeFromCart(userId, itemOrCourseId) {
  const cart = await getOrCreateCart(userId);
  const deletedByItem = await prisma.cartItem.deleteMany({
    where: {
      id: itemOrCourseId,
      cartId: cart.id,
    },
  });

  if (deletedByItem.count > 0) {
    return getCart(userId);
  }

  const deletedByCourse = await prisma.cartItem.deleteMany({
    where: {
      cartId: cart.id,
      courseId: itemOrCourseId,
    },
  });

  if (deletedByCourse.count === 0) {
    throw new ApiError(404, "Item not found in cart");
  }

  return getCart(userId);
}

export async function validateCartCoupon(userId, couponCode) {
  const cart = await getCart(userId);
  const items = Array.isArray(cart?.items) ? cart.items : [];
  if (!items.length) {
    throw new ApiError(400, "Cart is empty");
  }

  const courseIds = items.map((item) => item.courseId);
  const coupon = await resolveActiveCouponForCart(couponCode, courseIds);

  const subtotal = items.reduce(
    (sum, item) => sum + decimal(item?.course?.priceTier?.price),
    0,
  );

  const discountBase = coupon.courseId
    ? items
        .filter((item) => item.courseId === coupon.courseId)
        .reduce((sum, item) => sum + decimal(item?.course?.priceTier?.price), 0)
    : subtotal;

  const discountAmount = calculateDiscountForSubtotal(coupon, discountBase);
  const totalAmount = Number(Math.max(0, subtotal - discountAmount).toFixed(2));

  return {
    coupon: {
      id: coupon.id,
      code: coupon.code,
      courseId: coupon.courseId || null,
    },
    subtotal: Number(subtotal.toFixed(2)),
    discountAmount,
    totalAmount,
    currency: "PHP",
  };
}

