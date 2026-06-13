import { prisma } from "../../shared/database/prisma.js";
import { getPagination, toPagedResult } from "../../shared/utils/pagination.js";
import { emitNotificationToUser } from "../../shared/realtime/socket.js";

export async function createNotification(payload) {
  const notification = await prisma.notification.create({
    data: payload,
  });
  emitNotificationToUser(notification.userId, {
    id: notification.id,
    type: notification.type,
    title: notification.title,
    createdAt: notification.createdAt,
  });
  return notification;
}

export async function listMyNotifications(userId, query) {
  const { page, limit, skip } = getPagination(query);
  const allowedTypes = new Set([
    "SYSTEM",
    "ORDER",
    "ENROLLMENT",
    "COURSE_REVIEW",
    "PAYOUT",
    "COURSE_APPROVAL",
  ]);

  const normalizedType = String(query?.type || "")
    .trim()
    .toUpperCase();
  const normalizedRead = String(query?.read || "")
    .trim()
    .toLowerCase();
  const search = String(query?.q || query?.search || "")
    .trim()
    .slice(0, 120);
  const kind = String(query?.kind || "")
    .trim()
    .slice(0, 80);

  const where = {
    userId,
    ...(allowedTypes.has(normalizedType) ? { type: normalizedType } : {}),
    ...(normalizedRead === "read"
      ? { readAt: { not: null } }
      : normalizedRead === "unread"
        ? { readAt: null }
        : {}),
    ...(search
      ? {
          OR: [
            { title: { contains: search, mode: "insensitive" } },
            { message: { contains: search, mode: "insensitive" } },
          ],
        }
      : {}),
    ...(kind
      ? {
          metadata: {
            path: ["notificationKind"],
            equals: kind,
          },
        }
      : {}),
  };
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
