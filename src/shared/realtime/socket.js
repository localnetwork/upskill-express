import { Server } from "socket.io";
import { env } from "../config/env.js";
import { verifyAccessToken } from "../utils/jwt.js";
import { prisma } from "../database/prisma.js";

let io = null;
const onlineConnectionCounts = new Map();
const callSessions = new Map();
const socketCallSessionKeys = new Map();
const CALL_AUTO_END_MS = 5 * 60 * 1000;

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

function toCallRoom(roomId) {
  const id = String(roomId || "").trim();
  return id ? `chat-call:${id}` : "";
}

function mapUserLite(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username || "",
    firstName: user.firstName || "",
    lastName: user.lastName || "",
    email: user.email || "",
  };
}

function toCallSessionKey(conversationId, roomId) {
  const conv = String(conversationId || "").trim();
  const room = String(roomId || "").trim();
  if (!conv || !room) return "";
  return `${conv}::${room}`;
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
    const attachSocketToCallSession = (sessionKey) => {
      if (!sessionKey) return;
      const existing = socketCallSessionKeys.get(socket.id) || new Set();
      existing.add(sessionKey);
      socketCallSessionKeys.set(socket.id, existing);
    };

    const detachSocketFromCallSession = (sessionKey) => {
      const existing = socketCallSessionKeys.get(socket.id);
      if (!existing) return;
      existing.delete(sessionKey);
      if (!existing.size) socketCallSessionKeys.delete(socket.id);
    };

    const clearSessionTimers = (session) => {
      if (!session) return;
      if (session.inactivityTimer) {
        clearTimeout(session.inactivityTimer);
        session.inactivityTimer = null;
      }
      if (session.noJoinTimer) {
        clearTimeout(session.noJoinTimer);
        session.noJoinTimer = null;
      }
    };

    const touchCallSession = (sessionKey) => {
      const session = callSessions.get(sessionKey);
      if (!session) return;
      session.lastActivityAt = Date.now();
      if (session.inactivityTimer) clearTimeout(session.inactivityTimer);
      session.inactivityTimer = setTimeout(() => {
        endCallSession(sessionKey, {
          reason: "inactivity",
          endedByUserId: null,
          endedByUser: null,
        }).catch(() => {});
      }, CALL_AUTO_END_MS);
    };

    const syncNoJoinTimer = (sessionKey) => {
      const session = callSessions.get(sessionKey);
      if (!session) return;
      if (session.participants.size >= 2) {
        if (session.noJoinTimer) {
          clearTimeout(session.noJoinTimer);
          session.noJoinTimer = null;
        }
        return;
      }
      if (session.noJoinTimer) return;
      session.noJoinTimer = setTimeout(() => {
        endCallSession(sessionKey, {
          reason: "no_join",
          endedByUserId: null,
          endedByUser: null,
        }).catch(() => {});
      }, CALL_AUTO_END_MS);
    };

    const endCallSession = async (
      sessionKey,
      { reason = "ended", endedByUserId = null, endedByUser = null } = {},
    ) => {
      const session = callSessions.get(sessionKey);
      if (!session) return;
      callSessions.delete(sessionKey);
      clearSessionTimers(session);

      const participants = await prisma.chatConversationParticipant.findMany({
        where: { conversationId: session.conversationId },
        include: {
          user: {
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
              email: true,
            },
          },
        },
      });

      const normalizedEndedByUser =
        endedByUser || mapUserLite(participants.find(
          (participant) =>
            endedByUserId &&
            String(participant.userId) === String(endedByUserId),
        )?.user);

      for (const participant of participants) {
        if (!participant?.userId) continue;
        io.to(toUserRoom(participant.userId)).emit("chat:call:ended-notice", {
          conversationId: session.conversationId,
          roomId: session.roomId,
          callId: session.callId,
          endedByUserId: endedByUserId || null,
          endedByUser: normalizedEndedByUser || null,
          reason,
          endedAt: new Date().toISOString(),
        });
      }

      io.to(toCallRoom(session.roomId)).emit("chat:call:ended", {
        conversationId: session.conversationId,
        roomId: session.roomId,
        callId: session.callId,
        endedByUserId: endedByUserId || null,
        reason,
        endedAt: new Date().toISOString(),
      });
    };

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

    socket.on("chat:call:start", async (payload = {}, ack) => {
      try {
        const conversationId = String(payload?.conversationId || "").trim();
        const roomId =
          String(payload?.roomId || "").trim() || `ROOM:${conversationId}`;
        const callId =
          String(payload?.callId || "").trim() ||
          String(Math.floor(Date.now() / 1000));
        const hasVideo = Boolean(payload?.hasVideo ?? true);
        const initializeVideo = Boolean(payload?.initializeVideo ?? hasVideo);
        const isE2eeMandated = Boolean(payload?.isE2eeMandated ?? true);
        if (!conversationId) {
          if (typeof ack === "function") {
            ack({ ok: false, message: "conversationId is required" });
          }
          return;
        }

        const membership = await prisma.chatConversationParticipant.findFirst({
          where: {
            conversationId,
            userId: socket.userId,
          },
          select: { id: true },
        });
        if (!membership) {
          if (typeof ack === "function") {
            ack({ ok: false, message: "Not a conversation participant" });
          }
          return;
        }

        const participants = await prisma.chatConversationParticipant.findMany({
          where: { conversationId },
          include: {
            user: {
              select: {
                id: true,
                username: true,
                firstName: true,
                lastName: true,
                email: true,
              },
            },
          },
        });
        const fromParticipant = participants.find(
          (participant) => String(participant.userId) === String(socket.userId),
        );
        const fromUser = mapUserLite(fromParticipant?.user);
        const startedAt = new Date().toISOString();
        const sessionKey = toCallSessionKey(conversationId, roomId);
        const existing = callSessions.get(sessionKey);
        if (existing) {
          clearSessionTimers(existing);
        }
        callSessions.set(sessionKey, {
          conversationId,
          roomId,
          callId,
          startedByUserId: socket.userId,
          startedAt: Date.now(),
          lastActivityAt: Date.now(),
          participants: new Set(),
          inactivityTimer: null,
          noJoinTimer: null,
        });
        touchCallSession(sessionKey);
        syncNoJoinTimer(sessionKey);

        for (const participant of participants) {
          if (!participant?.userId) continue;
          if (String(participant.userId) === String(socket.userId)) continue;
          io.to(toUserRoom(participant.userId)).emit("chat:call:incoming", {
            conversationId,
            fromUserId: socket.userId,
            fromUser,
            roomId,
            callId,
            hasVideo,
            initializeVideo,
            isE2eeMandated,
            startedAt,
          });
        }

        if (typeof ack === "function") {
          ack({
            ok: true,
            data: {
              conversationId,
              roomId,
              callId,
              hasVideo,
              initializeVideo,
              isE2eeMandated,
              startedAt,
            },
          });
        }
      } catch (_error) {
        if (typeof ack === "function") {
          ack({ ok: false, message: "Failed to start call" });
        }
      }
    });

    socket.on("chat:call:join", async (payload = {}, ack) => {
      try {
        const conversationId = String(payload?.conversationId || "").trim();
        const roomId = String(payload?.roomId || "").trim();
        if (!conversationId || !roomId) {
          if (typeof ack === "function") {
            ack({
              ok: false,
              message: "conversationId and roomId are required",
            });
          }
          return;
        }

        const membership = await prisma.chatConversationParticipant.findFirst({
          where: {
            conversationId,
            userId: socket.userId,
          },
          include: {
            user: {
              select: {
                id: true,
                username: true,
                firstName: true,
                lastName: true,
                email: true,
              },
            },
          },
        });
        if (!membership) {
          if (typeof ack === "function") {
            ack({ ok: false, message: "Not a conversation participant" });
          }
          return;
        }

        const callRoom = toCallRoom(roomId);
        const sessionKey = toCallSessionKey(conversationId, roomId);
        if (!callRoom) {
          if (typeof ack === "function") {
            ack({ ok: false, message: "Invalid roomId" });
          }
          return;
        }

        socket.join(callRoom);
        attachSocketToCallSession(sessionKey);
        const session =
          callSessions.get(sessionKey) || {
            conversationId,
            roomId,
            callId: String(payload?.callId || "").trim() || null,
            startedByUserId: null,
            startedAt: Date.now(),
            lastActivityAt: Date.now(),
            participants: new Set(),
            inactivityTimer: null,
            noJoinTimer: null,
          };
        session.participants.add(String(socket.userId));
        callSessions.set(sessionKey, session);
        touchCallSession(sessionKey);
        syncNoJoinTimer(sessionKey);

        const participantsCount = Number(
          io.sockets.adapter.rooms.get(callRoom)?.size || 0,
        );

        socket.to(callRoom).emit("chat:call:participant-joined", {
          conversationId,
          roomId,
          userId: socket.userId,
          user: mapUserLite(membership.user),
          joinedAt: new Date().toISOString(),
        });

        if (typeof ack === "function") {
          ack({
            ok: true,
            data: {
              conversationId,
              roomId,
              isInitiator: participantsCount === 1,
              participantsCount,
              userId: socket.userId,
            },
          });
        }
      } catch (_error) {
        if (typeof ack === "function") {
          ack({ ok: false, message: "Failed to join call room" });
        }
      }
    });

    socket.on("chat:call:signal", async (payload = {}, ack) => {
      try {
        const conversationId = String(payload?.conversationId || "").trim();
        const roomId = String(payload?.roomId || "").trim();
        const signalType = String(payload?.signalType || "").trim();
        const callRoom = toCallRoom(roomId);
        const sessionKey = toCallSessionKey(conversationId, roomId);
        if (!conversationId || !roomId || !signalType || !callRoom) {
          if (typeof ack === "function") {
            ack({
              ok: false,
              message: "conversationId, roomId, and signalType are required",
            });
          }
          return;
        }

        const membership = await prisma.chatConversationParticipant.findFirst({
          where: {
            conversationId,
            userId: socket.userId,
          },
          select: { id: true },
        });
        if (!membership) {
          if (typeof ack === "function") {
            ack({ ok: false, message: "Not a conversation participant" });
          }
          touchCallSession(sessionKey);
          return;
        }

        const eventPayload = {
          conversationId,
          roomId,
          signalType,
          sdp: payload?.sdp || null,
          candidate: payload?.candidate || null,
          fromUserId: socket.userId,
        };

        const targetUserId = String(payload?.toUserId || "").trim();
        if (targetUserId) {
          io.to(toUserRoom(targetUserId)).emit("chat:call:signal", eventPayload);
        } else {
          socket.to(callRoom).emit("chat:call:signal", eventPayload);
        }

        if (typeof ack === "function") {
          ack({ ok: true });
        }
      } catch (_error) {
        if (typeof ack === "function") {
          ack({ ok: false, message: "Failed to relay call signal" });
        }
      }
    });

    socket.on("chat:call:heartbeat", async (payload = {}, ack) => {
      try {
        const conversationId = String(payload?.conversationId || "").trim();
        const roomId = String(payload?.roomId || "").trim();
        const sessionKey = toCallSessionKey(conversationId, roomId);
        if (!sessionKey) {
          if (typeof ack === "function") {
            ack({ ok: false, message: "conversationId and roomId are required" });
          }
          return;
        }

        const membership = await prisma.chatConversationParticipant.findFirst({
          where: {
            conversationId,
            userId: socket.userId,
          },
          select: { id: true },
        });
        if (!membership) {
          if (typeof ack === "function") {
            ack({ ok: false, message: "Not a conversation participant" });
          }
          return;
        }
        const session = callSessions.get(sessionKey);
        if (session) {
          session.participants.add(String(socket.userId));
          touchCallSession(sessionKey);
          syncNoJoinTimer(sessionKey);
        }
        if (typeof ack === "function") ack({ ok: true });
      } catch (_error) {
        if (typeof ack === "function") {
          ack({ ok: false, message: "Failed heartbeat" });
        }
      }
    });

    socket.on("chat:call:end", async (payload = {}, ack) => {
      try {
        const conversationId = String(payload?.conversationId || "").trim();
        const roomId = String(payload?.roomId || "").trim();
        const callId = String(payload?.callId || "").trim() || null;
        const callRoom = toCallRoom(roomId);
        const sessionKey = toCallSessionKey(conversationId, roomId);
        if (!conversationId || !roomId || !callRoom) {
          if (typeof ack === "function") {
            ack({ ok: false, message: "conversationId and roomId are required" });
          }
          return;
        }

        const membership = await prisma.chatConversationParticipant.findFirst({
          where: {
            conversationId,
            userId: socket.userId,
          },
          select: { id: true },
        });
        if (!membership) {
          if (typeof ack === "function") {
            ack({ ok: false, message: "Not a conversation participant" });
          }
          return;
        }

        socket.leave(callRoom);
        detachSocketFromCallSession(sessionKey);
        await endCallSession(sessionKey, {
          reason: "ended",
          endedByUserId: socket.userId,
          endedByUser: null,
        });
        if (typeof ack === "function") ack({ ok: true });
      } catch (_error) {
        if (typeof ack === "function") {
          ack({ ok: false, message: "Failed to end call" });
        }
      }
    });

    socket.on("disconnect", () => {
      const callKeys = socketCallSessionKeys.get(socket.id);
      if (callKeys?.size) {
        for (const sessionKey of callKeys) {
          const session = callSessions.get(sessionKey);
          if (!session) continue;
          session.participants.delete(String(socket.userId));
          syncNoJoinTimer(sessionKey);
        }
        socketCallSessionKeys.delete(socket.id);
      }
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
