import { prisma } from "../../shared/database/prisma.js";
import { getPagination, toPagedResult } from "../../shared/utils/pagination.js";
import { emitNotificationToUser } from "../../shared/realtime/socket.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { getUserProfilePicture } from "../user/user.service.js";
import { getMyOrder } from "../order/order.service.js";

const PERSON_KEYS = ["requester", "responder"];

async function enrichNotifications(userId, rows, { withOrder = false } = {}) {
  const personIds = new Set();
  for (const row of rows) {
    for (const key of PERSON_KEYS) {
      const id = row.metadata?.[key]?.id;
      if (id) personIds.add(id);
    }
  }

  const pictures = new Map();
  await Promise.all(
    Array.from(personIds).map(async (id) => {
      try {
        const picture = await getUserProfilePicture(id);
        if (picture?.path) pictures.set(id, picture.path);
      } catch (_error) {}
    }),
  );

  return Promise.all(
    rows.map(async (row) => {
      if (!row.metadata || typeof row.metadata !== "object") return row;
      const metadata = { ...row.metadata };
      for (const key of PERSON_KEYS) {
        if (metadata[key]?.id) {
          metadata[key] = {
            ...metadata[key],
            picture: pictures.get(metadata[key].id) || null,
          };
        }
      }

      if (withOrder && metadata.orderId) {
        try {
          const order = await getMyOrder(userId, metadata.orderId);
          metadata.order = {
            id: order.id,
            status: order.status,
            currency: order.currency,
            subtotalAmount: order.subtotalAmount,
            discountAmount: order.discountAmount,
            taxAmount: order.taxAmount,
            totalAmount: order.totalAmount,
            paymentMethod: order.paymentMethod,
            createdAt: order.createdAt,
            items: order.items.map((item) => ({
              id: item.id,
              totalAmount: item.totalAmount,
              title: item.course?.title,
              slug: item.course?.slug,
              image: item.course?.cover_image?.path || null,
              instructor:
                `${item.course?.educator?.firstName || ""} ${item.course?.educator?.lastName || ""}`.trim() ||
                item.course?.educator?.username ||
                "",
            })),
          };
        } catch (_error) {}
      }

      return { ...row, metadata };
    }),
  );
}

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
  return toPagedResult(await enrichNotifications(userId, rows), total, page, limit);
}

export async function markAsRead(userId, notificationId) {
  return prisma.notification.updateMany({
    where: { id: notificationId, userId },
    data: { readAt: new Date() },
  });
}

export async function getMyNotification(userId, notificationId) {
  const notification = await prisma.notification.findFirst({
    where: {
      id: notificationId,
      userId,
    },
  });

  if (!notification) {
    throw new ApiError(404, "Notification not found");
  }

  const [enriched] = await enrichNotifications(userId, [notification], {
    withOrder: true,
  });
  return enriched;
}
