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

const USER_PICTURE_KEY_PREFIX = "profile_picture::";

function getUserPictureSettingKey(userId) {
  return `${USER_PICTURE_KEY_PREFIX}${userId}`;
}

function safeParseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
}

function getRealName(user) {
  if (!user) return "";
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();
  return fullName || user.username || "";
}

// Resolve a batch of media IDs to their storage paths.
async function resolveMediaPathsById(mediaIds = []) {
  const uniqueIds = [...new Set(mediaIds.filter(Boolean))];
  const result = {};
  if (!uniqueIds.length) return result;

  const mediaRows = await prisma.media.findMany({
    where: { id: { in: uniqueIds } },
    select: { id: true, storagePath: true },
  });
  for (const media of mediaRows) {
    result[media.id] = media.storagePath;
  }
  return result;
}

// Resolve profile pictures (from PlatformSetting key `profile_picture::<userId>`)
// for a batch of user IDs, mapping userId -> storagePath.
async function resolveProfilePicturesByUserId(userIds = []) {
  const uniqueIds = [...new Set(userIds.filter(Boolean))];
  const result = {};
  if (!uniqueIds.length) return result;

  const settings = await prisma.platformSetting.findMany({
    where: {
      key: { in: uniqueIds.map(getUserPictureSettingKey) },
    },
    select: { key: true, value: true },
  });

  const keyToUserId = new Map(uniqueIds.map((id) => [getUserPictureSettingKey(id), id]));
  const mediaIdByUserId = new Map();

  for (const setting of settings) {
    const userId = keyToUserId.get(setting.key);
    if (!userId) continue;
    const parsed = safeParseJson(setting.value);
    const mediaId = String(parsed?.mediaId || parsed?.id || setting.value || "").trim();
    if (!mediaId) continue;
    mediaIdByUserId.set(userId, mediaId);
  }

  if (mediaIdByUserId.size) {
    const mediaRows = await prisma.media.findMany({
      where: { id: { in: [...mediaIdByUserId.values()] } },
      select: { id: true, storagePath: true },
    });
    const mediaPathById = new Map(mediaRows.map((m) => [m.id, m.storagePath]));
    for (const [userId, mediaId] of mediaIdByUserId) {
      result[userId] = mediaPathById.get(mediaId) || null;
    }
  }

  return result;
}

function mapMessage(message) {
  return {
    id: message.id,
    conversationId: message.conversationId,
    senderId: message.senderId,
    body: message.body || "",
    mediaPath: message.mediaPath || null,
    mediaType: message.mediaType || null,
    type: message.messageType || "USER",
    metadata: message.metadata || null,
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

  // Batched lookups for participant chat photos, profile pictures, and backgrounds.
  const participantRows = rows.flatMap((conversation) => conversation.participants);
  const backgroundMediaIds = [
    ...new Set(
      participantRows.map((item) => item.backgroundMediaId).filter(Boolean),
    ),
  ];
  const participantUserIds = [
    ...new Set(participantRows.map((item) => item.userId)),
  ];
  const [profilePicturesByUserId, backgroundPathsById] =
    await Promise.all([
      resolveProfilePicturesByUserId(participantUserIds),
      resolveMediaPathsById(backgroundMediaIds),
    ]);

  const data = await Promise.all(
    rows.map(async (conversation) => {
      const me = conversation.participants.find((item) => item.userId === userId);
      const others = conversation.participants
        .filter((item) => item.userId !== userId)
        .map((item) => ({
          ...mapUserLite(item.user),
          nickname: item.nickname || null,
          photoPath: profilePicturesByUserId[item.userId] || null,
        }));
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
        nickname: item.nickname || null,
        photoPath: profilePicturesByUserId[item.userId] || null,
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
                  item.nickname ||
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
        myBackgroundPath: me?.backgroundMediaId
          ? backgroundPathsById[me.backgroundMediaId] || null
          : null,
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

// Creates a SYSTEM message and broadcasts it via the `chat:new` event.
// Uses the same transaction pattern as sendMessage (bumps lastMessageAt and
// the actor's lastReadAt).
export async function createSystemMessage(conversationId, actorId, body, metadata = null) {
  assertChatPrismaClientReady();
  const membership = await assertConversationMembership(actorId, conversationId);
  const now = new Date();

  const message = await prisma.chatMessage.create({
    data: {
      conversationId: membership.conversationId,
      senderId: actorId,
      body: String(body || "").trim() || null,
      messageType: "SYSTEM",
      metadata: metadata || null,
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
      where: { conversationId: membership.conversationId, userId: actorId },
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

export async function setParticipantNickname(
  userId,
  conversationId,
  targetUserId,
  nickname,
) {
  assertChatPrismaClientReady();
  const membership = await assertConversationMembership(userId, conversationId);
  const targetId = String(targetUserId || "").trim();
  if (!targetId) throw new ApiError(400, "targetUserId is required");

  const targetParticipant = await prisma.chatConversationParticipant.findFirst({
    where: {
      conversationId: membership.conversationId,
      userId: targetId,
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
  if (!targetParticipant) {
    throw new ApiError(404, "Target participant not found in this conversation");
  }

  const normalized = String(nickname || "").trim();
  const nextNickname = normalized ? normalized : null;
  const previousNickname = targetParticipant.nickname || null;

  await prisma.chatConversationParticipant.update({
    where: { id: targetParticipant.id },
    data: { nickname: nextNickname },
  });

  const actor = await prisma.user.findFirst({
    where: { id: userId },
    select: {
      id: true,
      username: true,
      firstName: true,
      lastName: true,
      email: true,
    },
  });
  const actorName = getRealName(actor);
  const targetName = getRealName(targetParticipant.user);

  let body;
  if (targetId === userId) {
    body = nextNickname
      ? `${actorName} changed their own nickname to ${nextNickname}`
      : `${actorName} removed their own nickname`;
  } else {
    body = nextNickname
      ? `${actorName} has changed ${targetName}'s nickname to ${nextNickname}`
      : `${actorName} removed ${targetName}'s nickname`;
  }

  const systemMessage = await createSystemMessage(
    membership.conversationId,
    userId,
    body,
    {
      kind: "NICKNAME_CHANGED",
      actorId: userId,
      targetUserId: targetId,
      previousNickname,
      newNickname: nextNickname,
    },
  );

  const participants = await prisma.chatConversationParticipant.findMany({
    where: { conversationId: membership.conversationId },
    select: { userId: true },
  });
  for (const participant of participants) {
    if (!participant?.userId) continue;
    emitChatToUser(participant.userId, {
      conversationId: membership.conversationId,
      settings: {
        targetUserId: targetId,
        nickname: nextNickname,
        updatedAt: new Date().toISOString(),
      },
    });
  }

  return {
    conversationId: membership.conversationId,
    targetUserId: targetId,
    nickname: nextNickname,
    systemMessage,
  };
}

export async function setConversationBackground(userId, conversationId, mediaId) {
  assertChatPrismaClientReady();
  const membership = await assertConversationMembership(userId, conversationId);
  const mediaIdValue = String(mediaId || "").trim();
  if (!mediaIdValue) throw new ApiError(400, "mediaId is required");

  const media = await prisma.media.findFirst({
    where: { id: mediaIdValue, userId },
    select: { id: true, storagePath: true },
  });
  if (!media) {
    throw new ApiError(404, "Media not found");
  }

  await prisma.chatConversationParticipant.update({
    where: { id: membership.id },
    data: { backgroundMediaId: media.id },
  });

  emitChatToUser(userId, {
    conversationId: membership.conversationId,
    background: {
      userId,
      backgroundPath: media.storagePath,
    },
  });

  return {
    conversationId: membership.conversationId,
    backgroundPath: media.storagePath,
  };
}

export async function clearConversationBackground(userId, conversationId) {
  assertChatPrismaClientReady();
  const membership = await assertConversationMembership(userId, conversationId);

  await prisma.chatConversationParticipant.update({
    where: { id: membership.id },
    data: { backgroundMediaId: null },
  });

  emitChatToUser(userId, {
    conversationId: membership.conversationId,
    background: {
      userId,
      backgroundPath: null,
    },
  });

  return {
    conversationId: membership.conversationId,
    backgroundPath: null,
  };
}

export async function getConversationDetail(userId, conversationId) {
  assertChatPrismaClientReady();
  const membership = await assertConversationMembership(userId, conversationId);

  const conversation = await prisma.chatConversation.findFirst({
    where: { id: membership.conversationId },
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
    },
  });
  if (!conversation) {
    throw new ApiError(404, "Conversation not found");
  }

  const participantRows = conversation.participants;
  const backgroundMediaIds = [
    ...new Set(
      participantRows.map((item) => item.backgroundMediaId).filter(Boolean),
    ),
  ];
  const participantUserIds = participantRows.map((item) => item.userId);

  const [profilePicturesByUserId, backgroundPathsById] =
    await Promise.all([
      resolveProfilePicturesByUserId(participantUserIds),
      resolveMediaPathsById(backgroundMediaIds),
    ]);

  const me = participantRows.find((item) => item.userId === userId);
  const others = participantRows.filter((item) => item.userId !== userId);
  const onlineMap = getOnlineStatusForUsers(participantUserIds);

  const participants = participantRows.map((item) => ({
    userId: item.userId,
    joinedAt: item.joinedAt,
    lastReadAt: item.lastReadAt,
    isOnline: Boolean(onlineMap[item.userId]),
    nickname: item.nickname || null,
    photoPath: profilePicturesByUserId[item.userId] || null,
    user: mapUserLite(item.user),
  }));

  return {
    id: conversation.id,
    title:
      conversation.title ||
      (conversation.isGroup
        ? "Group conversation"
        : others
            .map((item) =>
              item.nickname ||
              [item.user.firstName, item.user.lastName]
                .filter(Boolean)
                .join(" ")
                .trim() ||
              item.user.username,
            )
            .filter(Boolean)
            .join(", ")),
    isGroup: conversation.isGroup,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    lastMessageAt: conversation.lastMessageAt,
    createdById: conversation.createdById,
    participants,
    otherParticipants: others.map((item) => ({
      ...mapUserLite(item.user),
      nickname: item.nickname || null,
      photoPath: profilePicturesByUserId[item.userId] || null,
      isOnline: Boolean(onlineMap[item.userId]),
    })),
    myBackgroundPath: me?.backgroundMediaId
      ? backgroundPathsById[me.backgroundMediaId] || null
      : null,
  };
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
