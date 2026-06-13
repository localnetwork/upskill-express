import { Server } from "socket.io";
import { env } from "../config/env.js";
import { verifyAccessToken } from "../utils/jwt.js";
import { prisma } from "../database/prisma.js";

let io = null;

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
    }
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
