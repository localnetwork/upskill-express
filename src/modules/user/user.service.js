import { ApiError } from "../../shared/utils/ApiError.js";
import { comparePassword, hashPassword } from "../../shared/utils/security.js";
import { getPagination, toPagedResult } from "../../shared/utils/pagination.js";
import { mapPermissionsFromRoles } from "../../shared/utils/rolePermissions.js";
import { countMany, findById, findByUsername, findMany, updateById } from "./user.repository.js";

function getOptional(payload, key) {
  return payload[key] === undefined ? undefined : payload[key];
}

function mapUser(user) {
  const roles = user.roles?.map((role) => role.role.name) || [];
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
