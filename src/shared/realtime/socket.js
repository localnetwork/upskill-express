import { Server } from "socket.io";
import { env } from "../config/env.js";
import { verifyAccessToken } from "../utils/jwt.js";
import { prisma } from "../database/prisma.js";

let io = null;
const onlineConnectionCounts = new Map();

function toUserRoom(userId) {
  return `user:${userId}`;
}

function extractBearerToken(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.startsWith("Bearer ")) {
    return raw.slice(7).trim();
  }
  return raw;
}

function toPreviewRoom(userA, userB) {
  const a = String(userA || "").trim();
  const b = String(userB || "").trim();
  const [left, right] = [a, b].sort();
  return left && right ? `chat-preview:${left}:${right}` : "";
}

export function initSocket(server) {
  io = new Server(server, {
    cors: {
      origin: env.corsOrigin,
      credentials: true,
    },
  });

  io.use(async (socket, next) => {
    try {
      const tokenFromAuth = extractBearerToken(socket.handshake.auth?.token);
      const tokenFromHeader = extractBearerToken(
        socket.handshake.headers?.authorization,
      );
      const tokenFromQuery = extractBearerToken(socket.handshake.query?.token);
      const token = tokenFromAuth || tokenFromHeader || tokenFromQuery;

      if (!token) {
        return next(new Error("Unauthorized"));
      }

      const payload = verifyAccessToken(token);
      const user = await prisma.user.findFirst({
        where: {
          id: payload?.sub,
          deletedAt: null,
          isActive: true,
        },
        select: { id: true },
      });

      if (!user?.id) {
        return next(new Error("Unauthorized"));
      }

      socket.userId = user.id;
      return next();
    } catch (_error) {
      return next(new Error("Unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    if (socket.userId) {
      socket.join(toUserRoom(socket.userId));
      const current = Number(onlineConnectionCounts.get(socket.userId) || 0);
      onlineConnectionCounts.set(socket.userId, current + 1);
      io.to(toUserRoom(socket.userId)).emit("chat:presence", {
        userId: socket.userId,
        isOnline: true,
      });
    }

    socket.on("chat:preview:join", async (payload = {}, ack) => {
      try {
        const peerUserId = String(payload?.peerUserId || "").trim();
        if (!peerUserId) {
          if (typeof ack === "function") ack({ ok: false, message: "peerUserId is required" });
          return;
        }
        if (peerUserId === socket.userId) {
          if (typeof ack === "function") ack({ ok: false, message: "Cannot preview-chat with yourself" });
          return;
        }

        const peer = await prisma.user.findFirst({
          where: { id: peerUserId, deletedAt: null, isActive: true },
          select: { id: true },
        });
        if (!peer?.id) {
          if (typeof ack === "function") ack({ ok: false, message: "Peer user not found" });
          return;
        }

        const roomId = toPreviewRoom(socket.userId, peerUserId);
        if (!roomId) {
          if (typeof ack === "function") ack({ ok: false, message: "Unable to create preview room" });
          return;
        }

        socket.join(roomId);
        if (typeof ack === "function") {
          ack({ ok: true, roomId, peerUserId });
        }
      } catch (_error) {
        if (typeof ack === "function") ack({ ok: false, message: "Failed to join preview room" });
      }
    });

    socket.on("chat:preview:leave", (payload = {}, ack) => {
      const peerUserId = String(payload?.peerUserId || "").trim();
      const roomId = toPreviewRoom(socket.userId, peerUserId);
      if (roomId) socket.leave(roomId);
      if (typeof ack === "function") ack({ ok: true, roomId });
    });

    socket.on("chat:preview:message", async (payload = {}, ack) => {
      try {
        const peerUserId = String(payload?.peerUserId || "").trim();
        const body = String(payload?.body || "").trim();
        const mediaPath = String(payload?.mediaPath || "").trim();
        const mediaType = String(payload?.mediaType || "").trim().toUpperCase();

        if (!peerUserId) {
          if (typeof ack === "function") ack({ ok: false, message: "peerUserId is required" });
          return;
        }
        if (!body && !mediaPath) {
          if (typeof ack === "function") ack({ ok: false, message: "Message body or media attachment is required" });
          return;
        }
        if (mediaPath && mediaType && !["IMAGE", "VIDEO"].includes(mediaType)) {
          if (typeof ack === "function") ack({ ok: false, message: "mediaType must be IMAGE or VIDEO" });
          return;
        }

        const peer = await prisma.user.findFirst({
          where: { id: peerUserId, deletedAt: null, isActive: true },
          select: { id: true },
        });
        if (!peer?.id) {
          if (typeof ack === "function") ack({ ok: false, message: "Peer user not found" });
          return;
        }

        const roomId = toPreviewRoom(socket.userId, peerUserId);
        const eventPayload = {
          roomId,
          peerUserId,
          message: {
            id: `preview-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            senderId: socket.userId,
            body,
            mediaPath: mediaPath || null,
            mediaType: mediaPath ? mediaType || "IMAGE" : null,
            createdAt: new Date().toISOString(),
          },
        };

        io.to(roomId).emit("chat:preview:new", eventPayload);
        if (typeof ack === "function") ack({ ok: true, data: eventPayload });
      } catch (_error) {
        if (typeof ack === "function") ack({ ok: false, message: "Failed to send preview message" });
      }
    });

    socket.on("disconnect", () => {
      if (!socket.userId) return;
      const current = Number(onlineConnectionCounts.get(socket.userId) || 0);
      const next = Math.max(0, current - 1);
      if (next === 0) {
        onlineConnectionCounts.delete(socket.userId);
        io.to(toUserRoom(socket.userId)).emit("chat:presence", {
          userId: socket.userId,
          isOnline: false,
        });
      } else {
        onlineConnectionCounts.set(socket.userId, next);
      }
    });
  });

  return io;
}

export function emitNotificationToUser(userId, payload = {}) {
  if (!io || !userId) return;
  io.to(toUserRoom(userId)).emit("notification:new", payload);
}

export function emitCheckoutStatusToUser(userId, payload = {}) {
  if (!io || !userId) return;
  io.to(toUserRoom(userId)).emit("checkout:status", payload);
}

export function emitChatToUser(userId, payload = {}) {
  if (!io || !userId) return;
  io.to(toUserRoom(userId)).emit("chat:new", payload);
}

export function isUserOnline(userId) {
  return Number(onlineConnectionCounts.get(String(userId || "")) || 0) > 0;
}

export function getOnlineStatusForUsers(userIds = []) {
  const result = {};
  for (const userId of userIds) {
    const id = String(userId || "").trim();
    if (!id) continue;
    result[id] = isUserOnline(id);
  }
  return result;
}
