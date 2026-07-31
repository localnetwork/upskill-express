import { prisma } from "../../shared/database/prisma.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { getPagination, toPagedResult } from "../../shared/utils/pagination.js";
import { emitChatToUser } from "../../shared/realtime/socket.js";
import { getOnlineStatusForUsers } from "../../shared/realtime/socket.js";

function assertChatPrismaClientReady() {
  if (
    !prisma?.chatConversation ||
    !prisma?.chatConversationParticipant ||
    !prisma?.chatMessage ||
    !prisma?.chatMessageHidden
  ) {
    throw new ApiError(
      503,
      "Chat models are not ready. Run Prisma migrate + generate, then restart backend.",
    );
  }
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

function mapMessage(message) {
  return {
    id: message.id,
    conversationId: message.conversationId,
    senderId: message.senderId,
    body: message.body || "",
    mediaPath: message.mediaPath || null,
    mediaType: message.mediaType || null,
    deletedForEveryone: Boolean(message.deletedForEveryoneAt),
    deletedForEveryoneAt: message.deletedForEveryoneAt || null,
    deletedForEveryoneById: message.deletedForEveryoneById || null,
    seenByCount: Number(message.seenByCount || 0),
    seenByAll: Boolean(message.seenByAll),
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
    sender: mapUserLite(message.sender),
  };
}

async function assertUserActive(userId) {
  const user = await prisma.user.findFirst({
    where: { id: String(userId || ""), deletedAt: null, isActive: true },
    select: { id: true },
  });
  if (!user) throw new ApiError(404, "User not found");
  return user;
}

async function assertConversationMembership(userId, conversationId) {
  const membership = await prisma.chatConversationParticipant.findFirst({
    where: {
      userId,
      conversationId: String(conversationId || ""),
    },
    select: {
      id: true,
      conversationId: true,
      userId: true,
      lastReadAt: true,
      conversation: {
        select: {
          id: true,
          isGroup: true,
          title: true,
          lastMessageAt: true,
          createdAt: true,
        },
      },
    },
  });

  if (!membership) {
    throw new ApiError(403, "Not allowed to access this conversation");
  }
  return membership;
}

function buildConversationSearchWhere(userId, q = "") {
  const search = String(q || "").trim();
  const base = {
    participants: { some: { userId } },
  };
  if (!search) return base;

  return {
    ...base,
    AND: [
      {
        OR: [
          { title: { contains: search, mode: "insensitive" } },
          {
            messages: {
              some: { body: { contains: search, mode: "insensitive" } },
            },
          },
          {
            participants: {
              some: {
                userId: { not: userId },
                user: {
                  OR: [
                    { username: { contains: search, mode: "insensitive" } },
                    { firstName: { contains: search, mode: "insensitive" } },
                    { lastName: { contains: search, mode: "insensitive" } },
                    { email: { contains: search, mode: "insensitive" } },
                  ],
                },
              },
            },
          },
        ],
      },
    ],
  };
}

async function computeUnreadForConversation(conversationId, userId, lastReadAt) {
  return prisma.chatMessage.count({
    where: {
      conversationId,
      senderId: { not: userId },
      hiddenFor: {
        none: {
          userId,
        },
      },
      ...(lastReadAt ? { createdAt: { gt: lastReadAt } } : {}),
    },
  });
}

function canDeleteForEveryone(message, participants) {
  if (!message || !Array.isArray(participants)) return false;
  if (message.deletedForEveryoneAt) return false;

  const others = participants.filter((item) => item.userId !== message.senderId);
  for (const participant of others) {
    if (!participant.lastReadAt) continue;
    if (participant.lastReadAt >= message.createdAt) {
      return false;
    }
  }
  return true;
}

function computeSeenByStats(message, participants) {
  if (!message || !Array.isArray(participants)) {
    return { seenByCount: 0, seenByAll: false };
  }

  const others = participants.filter((item) => item.userId !== message.senderId);
  if (others.length === 0) return { seenByCount: 0, seenByAll: false };

  let seenByCount = 0;
  for (const participant of others) {
    if (participant.lastReadAt && participant.lastReadAt >= message.createdAt) {
      seenByCount += 1;
    }
  }
  return {
    seenByCount,
    seenByAll: seenByCount === others.length,
  };
}

export async function listConversations(userId, query = {}) {
  assertChatPrismaClientReady();
  const { page, limit, skip } = getPagination(query);
  const where = buildConversationSearchWhere(userId, query.q);

  const [rows, total] = await Promise.all([
    prisma.chatConversation.findMany({
      where,
      skip,
      take: limit,
      orderBy: { lastMessageAt: "desc" },
      include: {
        participants: {
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
        },
        messages: {
          take: 1,
          orderBy: { createdAt: "desc" },
          where: {
            hiddenFor: {
              none: {
                userId,
              },
            },
          },
          include: {
            sender: {
              select: {
                id: true,
                username: true,
                firstName: true,
                lastName: true,
                email: true,
              },
            },
          },
        },
      },
    }),
    prisma.chatConversation.count({ where }),
  ]);

  const data = await Promise.all(
    rows.map(async (conversation) => {
      const me = conversation.participants.find((item) => item.userId === userId);
      const others = conversation.participants
        .filter((item) => item.userId !== userId)
        .map((item) => mapUserLite(item.user));
      const onlineMap = getOnlineStatusForUsers(others.map((item) => item.id));
      const unreadCount = await computeUnreadForConversation(
        conversation.id,
        userId,
        me?.lastReadAt || null,
      );

      const participantsWithPresence = conversation.participants.map((item) => ({
        userId: item.userId,
        joinedAt: item.joinedAt,
        lastReadAt: item.lastReadAt,
        isOnline: Boolean(onlineMap[item.userId]),
        user: mapUserLite(item.user),
      }));

      const lastMessage = conversation.messages[0] || null;
      const seenStats = lastMessage
        ? computeSeenByStats(lastMessage, conversation.participants)
        : { seenByCount: 0, seenByAll: false };

      return {
        id: conversation.id,
        title:
          conversation.title ||
          (conversation.isGroup
            ? "Group conversation"
            : others
                .map((item) =>
                  [item.firstName, item.lastName].filter(Boolean).join(" ").trim() ||
                  item.username,
                )
                .filter(Boolean)
                .join(", ")),
        isGroup: conversation.isGroup,
        participants: participantsWithPresence,
        otherParticipants: others.map((item) => ({
          ...item,
          isOnline: Boolean(onlineMap[item.id]),
        })),
        lastMessageAt: conversation.lastMessageAt,
        lastMessage: lastMessage
          ? mapMessage({
              ...lastMessage,
              ...seenStats,
            })
          : null,
        unreadCount,
      };
    }),
  );

  const totalUnread = data.reduce(
    (sum, item) => sum + Number(item.unreadCount || 0),
    0,
  );

  return {
    ...toPagedResult(data, total, page, limit),
    summary: {
      totalUnread,
    },
  };
}

export async function createDirectConversation(userId, payload = {}) {
  assertChatPrismaClientReady();
  const participantId = String(payload.participantId || "").trim();
  if (!participantId) throw new ApiError(400, "participantId is required");
  if (participantId === userId) {
    throw new ApiError(400, "Cannot create a conversation with yourself");
  }

  await assertUserActive(participantId);

  const existing = await prisma.chatConversation.findFirst({
    where: {
      isGroup: false,
      AND: [
        { participants: { some: { userId } } },
        { participants: { some: { userId: participantId } } },
        {
          NOT: {
            participants: {
              some: {
                userId: { notIn: [userId, participantId] },
              },
            },
          },
        },
      ],
    },
    select: { id: true },
  });
  if (existing?.id) {
    return { conversationId: existing.id, created: false };
  }

  const now = new Date();
  const created = await prisma.chatConversation.create({
    data: {
      createdById: userId,
      isGroup: false,
      lastMessageAt: now,
      participants: {
        create: [{ userId, lastReadAt: now }, { userId: participantId }],
      },
    },
    select: { id: true },
  });

  if (payload.initialMessage && String(payload.initialMessage).trim()) {
    await sendMessage(userId, {
      conversationId: created.id,
      body: String(payload.initialMessage).trim(),
    });
  }

  return { conversationId: created.id, created: true };
}

export async function listConversationMessages(userId, conversationId, query = {}) {
  assertChatPrismaClientReady();
  const membership = await assertConversationMembership(userId, conversationId);
  const { page, limit, skip } = getPagination(query);

  const participants = await prisma.chatConversationParticipant.findMany({
    where: { conversationId: membership.conversationId },
    select: { userId: true, lastReadAt: true },
  });

  const where = {
    conversationId: membership.conversationId,
    hiddenFor: {
      none: {
        userId,
      },
    },
  };
  const [rows, total] = await Promise.all([
    prisma.chatMessage.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        sender: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
      },
    }),
    prisma.chatMessage.count({ where }),
  ]);

  const mapped = rows
    .reverse()
    .map((row) => {
      const seenStats = computeSeenByStats(row, participants);
      return mapMessage({
        ...row,
        ...seenStats,
      });
    });

  return toPagedResult(mapped, total, page, limit);
}

export async function sendMessage(userId, payload = {}) {
  assertChatPrismaClientReady();
  const conversationId = String(payload.conversationId || "").trim();
  const body = String(payload.body || "").trim();
  const mediaPath = String(payload.mediaPath || "").trim();
  const mediaType = String(payload.mediaType || "").trim().toUpperCase();

  if (!conversationId) throw new ApiError(400, "conversationId is required");
  if (!body && !mediaPath) {
    throw new ApiError(400, "Message body or media attachment is required");
  }
  if (mediaPath && mediaType && !["IMAGE", "VIDEO"].includes(mediaType)) {
    throw new ApiError(400, "mediaType must be IMAGE or VIDEO");
  }

  const membership = await assertConversationMembership(userId, conversationId);
  const now = new Date();

  const message = await prisma.chatMessage.create({
    data: {
      conversationId: membership.conversationId,
      senderId: userId,
      body: body || null,
      mediaPath: mediaPath || null,
      mediaType: mediaPath ? mediaType || "IMAGE" : null,
    },
    include: {
      sender: {
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

  await prisma.$transaction([
    prisma.chatConversation.update({
      where: { id: membership.conversationId },
      data: { lastMessageAt: now },
    }),
    prisma.chatConversationParticipant.updateMany({
      where: { conversationId: membership.conversationId, userId },
      data: { lastReadAt: now },
    }),
  ]);

  const participants = await prisma.chatConversationParticipant.findMany({
    where: { conversationId: membership.conversationId },
    select: { userId: true },
  });
  const mapped = mapMessage(message);
  for (const participant of participants) {
    if (!participant?.userId) continue;
    emitChatToUser(participant.userId, {
      conversationId: membership.conversationId,
      message: mapped,
    });
  }

  return mapped;
}

export async function markConversationRead(userId, conversationId) {
  assertChatPrismaClientReady();
  const membership = await assertConversationMembership(userId, conversationId);
  const seenAt = new Date();
  await prisma.chatConversationParticipant.update({
    where: { id: membership.id },
    data: { lastReadAt: seenAt },
  });

  const participants = await prisma.chatConversationParticipant.findMany({
    where: { conversationId: membership.conversationId },
    select: { userId: true },
  });
  for (const participant of participants) {
    emitChatToUser(participant.userId, {
      conversationId: membership.conversationId,
      seen: {
        userId,
        seenAt: seenAt.toISOString(),
      },
    });
  }

  return { success: true };
}

export async function searchChatUsers(userId, query = {}) {
  assertChatPrismaClientReady();
  const q = String(query.q || "").trim();
  if (!q) return [];
  const limit = Math.min(Math.max(Number(query.limit || 8), 1), 20);

  const users = await prisma.user.findMany({
    where: {
      deletedAt: null,
      isActive: true,
      id: { not: userId },
      OR: [
        { username: { contains: q, mode: "insensitive" } },
        { firstName: { contains: q, mode: "insensitive" } },
        { lastName: { contains: q, mode: "insensitive" } },
        { email: { contains: q, mode: "insensitive" } },
      ],
    },
    take: limit,
    orderBy: [{ firstName: "asc" }, { username: "asc" }],
    select: {
      id: true,
      username: true,
      firstName: true,
      lastName: true,
      email: true,
    },
  });

  return users.map(mapUserLite);
}

export async function getChatUnreadCount(userId) {
  assertChatPrismaClientReady();
  const memberships = await prisma.chatConversationParticipant.findMany({
    where: { userId },
    select: {
      conversationId: true,
      lastReadAt: true,
    },
  });

  const counts = await Promise.all(
    memberships.map((item) =>
      computeUnreadForConversation(item.conversationId, userId, item.lastReadAt),
    ),
  );

  return {
    totalUnread: counts.reduce((sum, count) => sum + Number(count || 0), 0),
  };
}

function resolveMediaPathFromUploadedFile(file) {
  if (!file) return "";
  if (file.path && /^https?:\/\//i.test(file.path)) return file.path;
  if (file.filename) return `/uploads/${file.filename}`;
  if (file.path) return file.path;
  return "";
}

export async function uploadChatAttachment(userId, file) {
  assertChatPrismaClientReady();
  if (!file) throw new ApiError(400, "File is required");

  const mimeType = String(file.mimetype || "").toLowerCase();
  const isImage = mimeType.startsWith("image/");
  const isVideo = mimeType.startsWith("video/");
  if (!isImage && !isVideo) {
    throw new ApiError(400, "Only image and video uploads are allowed");
  }

  const path = resolveMediaPathFromUploadedFile(file);
  if (!path) throw new ApiError(500, "Failed to resolve uploaded file path");

  const mediaType = isVideo ? "VIDEO" : "IMAGE";
  const media = await prisma.media.create({
    data: {
      userId,
      storagePath: path,
      originalName: file.originalname || "attachment",
      mimeType: file.mimetype || "",
      mediaType,
      sizeInBytes: Number(file.size || 0),
    },
  });

  return {
    id: media.id,
    path: media.storagePath,
    title: media.originalName,
    mediaType,
    mimeType: media.mimeType,
  };
}

export async function deleteMessage(userId, messageId, mode = "FOR_ME") {
  assertChatPrismaClientReady();
  const normalizedMode = String(mode || "").trim().toUpperCase();
  if (!["FOR_ME", "FOR_EVERYONE"].includes(normalizedMode)) {
    throw new ApiError(400, "Invalid delete mode");
  }

  const message = await prisma.chatMessage.findFirst({
    where: {
      id: String(messageId || "").trim(),
    },
    include: {
      conversation: {
        select: {
          id: true,
        },
      },
    },
  });
  if (!message) throw new ApiError(404, "Message not found");

  await assertConversationMembership(userId, message.conversationId);

  if (normalizedMode === "FOR_ME") {
    await prisma.chatMessageHidden.upsert({
      where: {
        messageId_userId: {
          messageId: message.id,
          userId,
        },
      },
      create: {
        messageId: message.id,
        userId,
      },
      update: {},
    });
    return { success: true, mode: "FOR_ME", messageId: message.id };
  }

  if (message.senderId !== userId) {
    throw new ApiError(403, "Only sender can delete for everyone");
  }
  if (message.deletedForEveryoneAt) {
    return { success: true, mode: "FOR_EVERYONE", messageId: message.id };
  }

  const participants = await prisma.chatConversationParticipant.findMany({
    where: { conversationId: message.conversationId },
    select: { userId: true, lastReadAt: true },
  });
  if (!canDeleteForEveryone(message, participants)) {
    throw new ApiError(400, "Cannot delete for everyone because the message was seen");
  }

  const deletedAt = new Date();
  await prisma.chatMessage.update({
    where: { id: message.id },
    data: {
      body: null,
      mediaPath: null,
      mediaType: null,
      deletedForEveryoneAt: deletedAt,
      deletedForEveryoneById: userId,
    },
  });

  for (const participant of participants) {
    emitChatToUser(participant.userId, {
      conversationId: message.conversationId,
      deleted: {
        messageId: message.id,
        mode: "FOR_EVERYONE",
        deletedAt: deletedAt.toISOString(),
        deletedById: userId,
      },
    });
  }

  return { success: true, mode: "FOR_EVERYONE", messageId: message.id };
}
