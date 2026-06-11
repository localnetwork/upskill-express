import { prisma } from "../../shared/database/prisma.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { getPagination, toPagedResult } from "../../shared/utils/pagination.js";

export async function listMyOrders(userId, query) {
  const { page, limit, skip } = getPagination(query);
  const where = { userId };
  const [rows, total] = await Promise.all([
    prisma.order.findMany({
      where,
      skip,
      take: limit,
      include: { items: { include: { course: true } }, payment: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.order.count({ where }),
  ]);
  return toPagedResult(rows, total, page, limit);
}

export async function getMyOrder(userId, orderId) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, userId },
    include: {
      items: {
        include: {
          course: true,
        },
      },
      payment: true,
      taxTransaction: true,
    },
  });
  if (!order) {
    throw new ApiError(404, "Order not found");
  }
  return order;
}
