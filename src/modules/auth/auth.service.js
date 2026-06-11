import { prisma } from "../../shared/database/prisma.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../../shared/utils/jwt.js";
import { comparePassword, compareToken, hashPassword, hashToken, randomToken } from "../../shared/utils/security.js";
import { createUser, findUserByEmail, findUserById, findUserByUsername, updateUser } from "./auth.repository.js";

function getRoles(user) {
  return (user.roles || []).map((item) => item.role.name);
}

async function ensureDefaultRole(roleName) {
  const role = await prisma.role.findUnique({ where: { name: roleName } });
  if (!role) {
    throw new ApiError(500, `Default role not seeded: ${roleName}`);
  }
  return role;
}

function buildTokenPayload(user) {
  return {
    sub: user.id,
    email: user.email,
    roles: getRoles(user),
  };
}

export async function register(payload) {
  const [existingEmail, existingUsername] = await Promise.all([
    findUserByEmail(payload.email),
    findUserByUsername(payload.username),
  ]);

  if (existingEmail) {
    throw new ApiError(409, "Email already in use");
  }

  if (existingUsername) {
    throw new ApiError(409, "Username already in use");
  }

  const verificationToken = randomToken(24);
  const hashedPassword = await hashPassword(payload.password);
  const roleName = payload.role || "LEARNER";
  const defaultRole = await ensureDefaultRole(roleName);

  const user = await createUser({
    email: payload.email,
    username: payload.username,
    firstName: payload.firstName,
    lastName: payload.lastName,
    passwordHash: hashedPassword,
    verificationToken,
    roles: {
      create: [{ roleId: defaultRole.id }],
    },
  });

  return {
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
    },
    verificationToken,
  };
}

export async function login(payload) {
  const user = await findUserByEmail(payload.email);
  if (!user) {
    throw new ApiError(401, "Invalid credentials");
  }

  const valid = await comparePassword(payload.password, user.passwordHash);
  if (!valid) {
    throw new ApiError(401, "Invalid credentials");
  }

  if (user.deletedAt || !user.isActive) {
    throw new ApiError(403, "Account disabled");
  }

  const accessToken = signAccessToken(buildTokenPayload(user));
  const refreshToken = signRefreshToken(buildTokenPayload(user));
  const refreshTokenHash = await hashToken(refreshToken);

  await updateUser(user.id, { refreshTokenHash });

  return {
    accessToken,
    refreshToken,
    user: {
      id: user.id,
      email: user.email,
      username: user.username,
      firstName: user.firstName,
      lastName: user.lastName,
      roles: getRoles(user),
    },
  };
}

export async function refreshTokens(refreshToken) {
  const payload = verifyRefreshToken(refreshToken);
  const user = await findUserById(payload.sub);
  if (!user || !user.refreshTokenHash) {
    throw new ApiError(401, "Invalid refresh token");
  }

  const valid = await compareToken(refreshToken, user.refreshTokenHash);
  if (!valid) {
    throw new ApiError(401, "Invalid refresh token");
  }

  const nextAccessToken = signAccessToken(buildTokenPayload(user));
  const nextRefreshToken = signRefreshToken(buildTokenPayload(user));
  const nextRefreshTokenHash = await hashToken(nextRefreshToken);

  await updateUser(user.id, { refreshTokenHash: nextRefreshTokenHash });

  return {
    accessToken: nextAccessToken,
    refreshToken: nextRefreshToken,
  };
}

export async function forgotPassword(email) {
  const user = await findUserByEmail(email);
  if (!user) {
    return { success: true };
  }
  const token = randomToken(24);
  await updateUser(user.id, {
    resetPasswordToken: token,
    resetPasswordTokenExp: new Date(Date.now() + 1000 * 60 * 30),
  });
  return { token };
}

export async function resetPassword(token, password) {
  const user = await prisma.user.findFirst({
    where: {
      resetPasswordToken: token,
      resetPasswordTokenExp: { gt: new Date() },
      deletedAt: null,
    },
  });

  if (!user) {
    throw new ApiError(400, "Invalid or expired reset token");
  }

  await updateUser(user.id, {
    passwordHash: await hashPassword(password),
    resetPasswordToken: null,
    resetPasswordTokenExp: null,
  });

  return { success: true };
}

export async function verifyEmail(token) {
  const user = await prisma.user.findFirst({
    where: { verificationToken: token, deletedAt: null },
  });

  if (!user) {
    throw new ApiError(400, "Invalid verification token");
  }

  await updateUser(user.id, {
    verificationToken: null,
    emailVerifiedAt: new Date(),
  });

  return { success: true };
}
