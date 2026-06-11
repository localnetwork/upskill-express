import { ApiError } from "../../shared/utils/ApiError.js";
import { comparePassword, hashPassword } from "../../shared/utils/security.js";
import { getPagination, toPagedResult } from "../../shared/utils/pagination.js";
import { countMany, findById, findByUsername, findMany, updateById } from "./user.repository.js";

function mapUser(user) {
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
    roles: user.roles?.map((role) => role.role.name) || [],
  };
}

export async function getCurrentUser(userId) {
  const user = await findById(userId);
  if (!user || user.deletedAt) {
    throw new ApiError(404, "User not found");
  }
  return mapUser(user);
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

  const updated = await updateById(userId, {
    username: payload.username,
    firstName: payload.firstName || payload.firstname,
    lastName: payload.lastName || payload.lastname,
    passwordHash,
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
  const [data, total] = await Promise.all([
    findMany({ skip, limit, search: query.search || null }),
    countMany(query.search || null),
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
