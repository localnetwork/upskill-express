import { prisma } from "../../shared/database/prisma.js";
import { getPagination, toPagedResult } from "../../shared/utils/pagination.js";

export function createNotification(payload) {
  return prisma.notification.create({
    data: payload,
  });
}

export async function listMyNotifications(userId, query) {
  const { page, limit, skip } = getPagination(query);
  const where = { userId };
  const [rows, total] = await Promise.all([
    prisma.notification.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
    }),
    prisma.notification.count({ where }),
  ]);
  return toPagedResult(rows, total, page, limit);
}

export async function markAsRead(userId, notificationId) {
  return prisma.notification.updateMany({
    where: { id: notificationId, userId },
    data: { readAt: new Date() },
  });
}
