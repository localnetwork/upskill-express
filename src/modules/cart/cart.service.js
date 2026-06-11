import { prisma } from "../../shared/database/prisma.js";
import { ApiError } from "../../shared/utils/ApiError.js";

async function getOrCreateCart(userId) {
  const cart = await prisma.cart.findUnique({ where: { userId } });
  if (cart) return cart;
  return prisma.cart.create({ data: { userId } });
}

export async function getCart(userId) {
  const cart = await getOrCreateCart(userId);
  return prisma.cart.findUnique({
    where: { id: cart.id },
    include: {
      items: {
        include: {
          course: {
            include: { priceTier: true },
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
      where: { id: courseId, workflowStatus: "PUBLISHED", deletedAt: null },
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

  return getCart(userId);
}

export async function removeFromCart(userId, courseId) {
  const cart = await getOrCreateCart(userId);
  await prisma.cartItem.deleteMany({
    where: {
      cartId: cart.id,
      courseId,
    },
  });
  return getCart(userId);
}
