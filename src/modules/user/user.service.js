import { ApiError } from "../../shared/utils/ApiError.js";
import { comparePassword, hashPassword } from "../../shared/utils/security.js";
import { getPagination, toPagedResult } from "../../shared/utils/pagination.js";
import { mapPermissionsFromRoles } from "../../shared/utils/rolePermissions.js";
import { prisma } from "../../shared/database/prisma.js";
import { countMany, findById, findByUsername, findMany, updateById } from "./user.repository.js";
import { listUserActivityEvents, recordActivityEvent } from "../analytics/analytics.service.js";
import { listTrustedDevices, revokeTrustedDevice } from "../auth/trusted-device.service.js";
import { createNotification } from "../notification/notification.service.js";

const USER_PICTURE_KEY_PREFIX = "profile_picture::";

function getOptional(payload, key) {
  return payload[key] === undefined ? undefined : payload[key];
}

function normalizeQueryString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeRoleFilter(rawRole) {
  const normalizedRole = normalizeQueryString(rawRole).toUpperCase();
  if (!normalizedRole || normalizedRole === "ALL") return null;

  const allowedRoles = new Set(["ADMIN", "EDUCATOR", "LEARNER"]);
  return allowedRoles.has(normalizedRole) ? normalizedRole : null;
}

function normalizeStatusFilter(rawStatus) {
  const normalizedStatus = normalizeQueryString(rawStatus).toUpperCase();
  if (!normalizedStatus || normalizedStatus === "ALL") return null;

  const allowedStatuses = new Set(["ACTIVE", "SUSPENDED", "PENDING"]);
  return allowedStatuses.has(normalizedStatus) ? normalizedStatus : null;
}

function mapUser(user) {
  const roles = user.roles?.map((role) => role.role.name) || [];
  const status = !user.isActive
    ? "Suspended"
    : user.emailVerifiedAt
      ? "Active"
      : "Pending";

  return {
    id: user.id,
    email: user.email,
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    firstname: user.firstName,
    lastname: user.lastName,
    isActive: user.isActive,
    is_suspended: !user.isActive,
    verified: Boolean(user.emailVerifiedAt),
    status,
    headline: user.headline || "",
    biography: user.biography || "",
    link_website: user.link_website || "",
    link_facebook: user.link_facebook || "",
    link_instagram: user.link_instagram || "",
    link_linkedin: user.link_linkedin || "",
    link_tiktok: user.link_tiktok || "",
    link_x: user.link_x || "",
    link_youtube: user.link_youtube || "",
    link_github: user.link_github || "",
    roles,
    permissions: mapPermissionsFromRoles(roles),
  };
}

function getUserPictureSettingKey(userId) {
  return `${USER_PICTURE_KEY_PREFIX}${userId}`;
}

function normalizeFriendPair(userIdA, userIdB) {
  return [String(userIdA || ""), String(userIdB || "")].sort();
}

function mapFriendRequestState(request, currentUserId) {
  if (!request) {
    return {
      relationship: "NONE",
      requestId: null,
      requestStatus: null,
      direction: null,
    };
  }

  async function updateFriendRequestNotificationStatus(friendRequestId, requestStatus) {
    const rows = await prisma.notification.findMany({
      where: {
        metadata: {
          path: ["friendRequestId"],
          equals: friendRequestId,
        },
      },
      select: {
        id: true,
        metadata: true,
      },
    });

    if (!rows.length) return;

    await Promise.all(
      rows.map((row) =>
        prisma.notification.update({
          where: { id: row.id },
          data: {
            metadata: {
              ...(row.metadata && typeof row.metadata === "object" ? row.metadata : {}),
              requestStatus,
            },
          },
        }),
      ),
    );
  }

  if (request.status === "ACCEPTED") {
    return {
      relationship: "FRIENDS",
      requestId: request.id,
      requestStatus: request.status,
      direction: null,
    };
  }

  if (request.status === "PENDING") {
    const direction =
      request.requesterId === currentUserId ? "OUTGOING" : "INCOMING";
    return {
      relationship: direction === "OUTGOING" ? "REQUEST_SENT" : "REQUEST_RECEIVED",
      requestId: request.id,
      requestStatus: request.status,
      direction,
    };
  }

  return {
    relationship: "NONE",
    requestId: request.id,
    requestStatus: request.status,
    direction: null,
  };
}

function safeParseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
}

async function getUserProfilePicture(userId) {
  const setting = await prisma.platformSetting.findUnique({
    where: { key: getUserPictureSettingKey(userId) },
    select: { value: true },
  });

  const parsed = safeParseJson(setting?.value);
  const mediaId = String(parsed?.mediaId || parsed?.id || setting?.value || "").trim();
  if (!mediaId) return null;

  const media = await prisma.media.findFirst({
    where: {
      id: mediaId,
      userId,
      mediaType: "IMAGE",
    },
    select: {
      id: true,
      storagePath: true,
      originalName: true,
    },
  });

  if (!media) return null;
  return {
    id: media.id,
    path: media.storagePath,
    title: media.originalName || "",
  };
}

export async function getCurrentUser(userId) {
  const user = await findById(userId);
  if (!user || user.deletedAt) {
    throw new ApiError(404, "User not found");
  }
  const mapped = mapUser(user);
  const userPicture = await getUserProfilePicture(user.id);
  return {
    ...mapped,
    user_picture: userPicture,
  };
}

export async function updateCurrentUser(userId, payload) {
  const user = await findById(userId);
  if (!user || user.deletedAt) {
    throw new ApiError(404, "User not found");
  }

  if (payload.username && payload.username !== user.username) {
    const usernameOwner = await findByUsername(payload.username);
    if (usernameOwner && usernameOwner.id !== user.id) {
      throw new ApiError(409, "Username already in use");
    }
  }

  let passwordHash;
  if (payload.password) {
    passwordHash = await hashPassword(payload.password);
  }

  const firstName =
    payload.firstName === undefined ? payload.firstname : payload.firstName;
  const lastName =
    payload.lastName === undefined ? payload.lastname : payload.lastName;

  const updated = await updateById(userId, {
    username: payload.username,
    firstName,
    lastName,
    headline: getOptional(payload, "headline"),
    biography: getOptional(payload, "biography"),
    link_website: getOptional(payload, "link_website"),
    link_facebook: getOptional(payload, "link_facebook"),
    link_instagram: getOptional(payload, "link_instagram"),
    link_linkedin: getOptional(payload, "link_linkedin"),
    link_tiktok: getOptional(payload, "link_tiktok"),
    link_x: getOptional(payload, "link_x"),
    link_youtube: getOptional(payload, "link_youtube"),
    link_github: getOptional(payload, "link_github"),
    passwordHash,
  });

  await recordActivityEvent({
    eventType: "ACCOUNT_PROFILE_UPDATED",
    userId,
    pagePath: "/profile/basic-information",
    metadata: {
      changedFields: Object.keys(payload || {}),
    },
    dedupeWindowSeconds: 5,
  });

  return mapUser(updated);
}

export async function changePassword(userId, oldPassword, newPassword) {
  const user = await findById(userId);
  if (!user || user.deletedAt) {
    throw new ApiError(404, "User not found");
  }

  const valid = await comparePassword(oldPassword, user.passwordHash);
  if (!valid) {
    throw new ApiError(400, "Old password is incorrect");
  }

  await updateById(userId, {
    passwordHash: await hashPassword(newPassword),
  });

  return { success: true };
}

export async function listUsers(query) {
  const { page, limit, skip } = getPagination(query);
  const search = normalizeQueryString(query.search) || null;
  const role = normalizeRoleFilter(query.role);
  const status = normalizeStatusFilter(query.status);

  const [data, total] = await Promise.all([
    findMany({ skip, limit, search, role, status }),
    countMany({ search, role, status }),
  ]);
  return toPagedResult(
    data.map(mapUser),
    total,
    page,
    limit,
  );
}

export async function softDeleteUser(userId) {
  const user = await findById(userId);
  if (!user || user.deletedAt) {
    throw new ApiError(404, "User not found");
  }
  await updateById(userId, { deletedAt: new Date(), isActive: false });
  return { success: true };
}

export async function listCurrentUserActivity(userId, query = {}) {
  return listUserActivityEvents(userId, query);
}

export async function listCurrentUserDevices(userId) {
  return listTrustedDevices(userId);
}

export async function removeCurrentUserDevice(userId, deviceId) {
  const result = await revokeTrustedDevice(userId, deviceId);
  if (!result.success) {
    throw new ApiError(404, "Device not found");
  }
  return { success: true };
}

export async function getFriendRequestStatus(currentUserId, targetUserId) {
  if (currentUserId === targetUserId) {
    return {
      relationship: "SELF",
      requestId: null,
      requestStatus: null,
      direction: null,
    };
  }

  const targetUser = await findById(targetUserId);
  if (!targetUser || targetUser.deletedAt) {
    throw new ApiError(404, "Target user not found");
  }

  const [userAId, userBId] = normalizeFriendPair(currentUserId, targetUserId);
  const request = await prisma.friendRequest.findUnique({
    where: { userAId_userBId: { userAId, userBId } },
    select: {
      id: true,
      status: true,
      requesterId: true,
    },
  });

  return mapFriendRequestState(request, currentUserId);
}

export async function sendFriendRequest(currentUserId, targetUserId) {
  if (currentUserId === targetUserId) {
    throw new ApiError(400, "You cannot send a friend request to yourself");
  }

  const [currentUser, targetUser] = await Promise.all([
    findById(currentUserId),
    findById(targetUserId),
  ]);

  if (!currentUser || currentUser.deletedAt) {
    throw new ApiError(404, "User not found");
  }
  if (!targetUser || targetUser.deletedAt) {
    throw new ApiError(404, "Target user not found");
  }

  const [userAId, userBId] = normalizeFriendPair(currentUserId, targetUserId);
  const existing = await prisma.friendRequest.findUnique({
    where: { userAId_userBId: { userAId, userBId } },
  });

  if (existing?.status === "ACCEPTED") {
    throw new ApiError(409, "You are already friends");
  }

  if (existing?.status === "PENDING" && existing.requesterId === currentUserId) {
    return mapFriendRequestState(existing, currentUserId);
  }

  if (existing?.status === "PENDING" && existing.requesterId === targetUserId) {
    throw new ApiError(
      409,
      "This user already sent you a friend request. Confirm or decline it.",
    );
  }

  const payload = {
    requesterId: currentUserId,
    addresseeId: targetUserId,
    userAId,
    userBId,
    status: "PENDING",
    respondedAt: null,
  };

  const request = existing
    ? await prisma.friendRequest.update({
        where: { id: existing.id },
        data: payload,
      })
    : await prisma.friendRequest.create({
        data: payload,
      });

  await createNotification({
    userId: targetUserId,
    type: "SYSTEM",
    title: "New friend request",
    message: `${currentUser.firstName || currentUser.username} sent you a friend request.`,
    metadata: {
      notificationKind: "FRIEND_REQUEST",
      friendRequestId: request.id,
      requestStatus: "PENDING",
      requester: {
        id: currentUser.id,
        username: currentUser.username,
        firstName: currentUser.firstName || "",
        lastName: currentUser.lastName || "",
      },
    },
  });

  return mapFriendRequestState(request, currentUserId);
}

export async function cancelFriendRequest(currentUserId, targetUserId) {
  if (currentUserId === targetUserId) {
    throw new ApiError(400, "Invalid friend request target");
  }

  const [userAId, userBId] = normalizeFriendPair(currentUserId, targetUserId);
  const request = await prisma.friendRequest.findUnique({
    where: { userAId_userBId: { userAId, userBId } },
    select: {
      id: true,
      requesterId: true,
      addresseeId: true,
      status: true,
    },
  });

  if (!request || request.status !== "PENDING") {
    throw new ApiError(404, "Pending friend request not found");
  }

  if (request.requesterId !== currentUserId) {
    throw new ApiError(403, "You can only cancel your own friend request");
  }

  const updated = await prisma.friendRequest.update({
    where: { id: request.id },
    data: {
      status: "CANCELED",
      respondedAt: new Date(),
    },
  });

  await updateFriendRequestNotificationStatus(updated.id, "CANCELED");

  return mapFriendRequestState(updated, currentUserId);
}

export async function respondToFriendRequest(currentUserId, requestId, action) {
  const normalizedAction = String(action || "").toUpperCase();
  if (!["ACCEPT", "DECLINE"].includes(normalizedAction)) {
    throw new ApiError(400, "Invalid friend request action");
  }

  const request = await prisma.friendRequest.findUnique({
    where: { id: requestId },
    include: {
      requester: {
        select: {
          id: true,
          username: true,
          firstName: true,
          lastName: true,
        },
      },
      addressee: {
        select: {
          id: true,
          username: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  });

  if (!request || request.status !== "PENDING") {
    throw new ApiError(404, "Pending friend request not found");
  }

  if (request.addresseeId !== currentUserId) {
    throw new ApiError(403, "You cannot respond to this friend request");
  }

  const nextStatus = normalizedAction === "ACCEPT" ? "ACCEPTED" : "DECLINED";
  const updated = await prisma.friendRequest.update({
    where: { id: requestId },
    data: {
      status: nextStatus,
      respondedAt: new Date(),
    },
  });

  await updateFriendRequestNotificationStatus(updated.id, nextStatus);

  const responderName =
    request.addressee.firstName?.trim() || request.addressee.username;

  await createNotification({
    userId: request.requesterId,
    type: "SYSTEM",
    title:
      nextStatus === "ACCEPTED"
        ? "Friend request accepted"
        : "Friend request declined",
    message:
      nextStatus === "ACCEPTED"
        ? `${responderName} accepted your friend request.`
        : `${responderName} declined your friend request.`,
    metadata: {
      notificationKind: "FRIEND_REQUEST_RESPONSE",
      friendRequestId: request.id,
      requestStatus: nextStatus,
      responder: {
        id: request.addressee.id,
        username: request.addressee.username,
        firstName: request.addressee.firstName || "",
        lastName: request.addressee.lastName || "",
      },
    },
  });

  return mapFriendRequestState(updated, currentUserId);
}
