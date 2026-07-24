import { prisma } from "../../shared/database/prisma.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { signAccessToken, signPreAuthToken, signRefreshToken, verifyRefreshToken } from "../../shared/utils/jwt.js";
import { comparePassword, compareToken, hashPassword, hashToken, randomToken } from "../../shared/utils/security.js";
import { mapPermissionsFromRoles } from "../../shared/utils/rolePermissions.js";
import { createUser, findUserByEmail, findUserById, findUserByUsername, updateUser } from "./auth.repository.js";
import { recordActivityEvent } from "../analytics/analytics.service.js";
import { createNotification } from "../notification/notification.service.js";
import { env } from "../../shared/config/env.js";
import axios from "axios";
import {
  buildDeviceName,
  getRequestIpAddress,
  getRequestUserAgent,
  registerTrustedDevice,
  resolveDeviceLocationLabel,
  resolveTrustedDeviceForLogin,
} from "./trusted-device.service.js";

async function notifyNewDeviceLogin(userId, { deviceName, locationLabel, ipAddress, provider }) {
  await createNotification({
    userId,
    type: "SYSTEM",
    title: "New device login detected",
    message: `A new device signed in to your account from ${locationLabel || ipAddress || "an unknown location"}.`,
    metadata: {
      notificationKind: "SECURITY_NEW_DEVICE_LOGIN",
      provider: provider || "password",
      deviceName: deviceName || "Unknown device",
      locationLabel: locationLabel || null,
      ipAddress: ipAddress || null,
    },
  });
}

function getRoles(user) {
  return (user.roles || []).map((item) => item.role.name);
}

function mapAuthUser(user, roles = getRoles(user)) {
  const permissions = mapPermissionsFromRoles(roles);
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    firstname: user.firstName,
    lastname: user.lastName,
    verified: Boolean(user.emailVerifiedAt),
    isActive: user.isActive,
    is_suspended: !user.isActive,
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
    permissions,
  };
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

function normalizeRole(rawRole) {
  if (!rawRole) return "LEARNER";
  const value = String(rawRole).trim().toUpperCase();
  if (value === "2" || value === "EDUCATOR" || value === "INSTRUCTOR") return "EDUCATOR";
  if (value === "3" || value === "LEARNER" || value === "STUDENT") return "LEARNER";
  return "LEARNER";
}

function normalizeGoogleProfile(data) {
  return {
    email: String(data?.email || "").trim().toLowerCase(),
    emailVerified: String(data?.email_verified || "").toLowerCase() === "true",
    givenName: data?.given_name ? String(data.given_name).trim() : "",
    familyName: data?.family_name ? String(data.family_name).trim() : "",
    subject: data?.sub ? String(data.sub) : "",
    audience: data?.aud ? String(data.aud) : "",
  };
}

async function verifyGoogleIdToken(idToken) {
  if (!env.googleClientId) {
    throw new ApiError(500, "Missing GOOGLE_CLIENT_ID");
  }

  let response;
  try {
    response = await axios.get("https://oauth2.googleapis.com/tokeninfo", {
      params: { id_token: idToken },
      timeout: 10000,
    });
  } catch {
    throw new ApiError(401, "Invalid Google credential");
  }

  const profile = normalizeGoogleProfile(response?.data || {});

  if (!profile.email || !profile.subject) {
    throw new ApiError(401, "Invalid Google credential");
  }

  if (!profile.emailVerified) {
    throw new ApiError(401, "Google email is not verified");
  }

  if (profile.audience !== env.googleClientId) {
    throw new ApiError(401, "Google credential does not match this app");
  }

  return profile;
}

function baseUsernameFromEmail(email) {
  const localPart = String(email || "").split("@")[0] || "user";
  const sanitized = localPart
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 32);

  if (sanitized.length >= 3) return sanitized;
  return `user${Date.now().toString().slice(-6)}`;
}

async function generateUniqueUsername(email) {
  const base = baseUsernameFromEmail(email);
  const existingBase = await findUserByUsername(base);
  if (!existingBase) return base;

  for (let i = 0; i < 20; i += 1) {
    const suffix = Math.floor(Math.random() * 9000 + 1000).toString();
    const candidate = `${base.slice(0, 36)}${suffix}`;
    const exists = await findUserByUsername(candidate);
    if (!exists) return candidate;
  }

  throw new ApiError(500, "Unable to generate a unique username");
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
  const roleName = normalizeRole(payload.role);
  const defaultRole = await ensureDefaultRole(roleName);

  const user = await createUser({
    email: payload.email,
    username: payload.username,
    firstName: payload.firstName || payload.firstname,
    lastName: payload.lastName || payload.lastname,
    passwordHash: hashedPassword,
    verificationToken,
    roles: {
      create: [{ roleId: defaultRole.id }],
    },
  });

  const tokenPayload = {
    sub: user.id,
    email: user.email,
    roles: [roleName],
  };
  const accessToken = signAccessToken(tokenPayload);
  const refreshToken = signRefreshToken(tokenPayload);
  const refreshTokenHash = await hashToken(refreshToken);
  await updateUser(user.id, { refreshTokenHash });

  await recordActivityEvent({
    eventType: "AUTH_REGISTER",
    userId: user.id,
    metadata: { role: roleName },
    dedupeWindowSeconds: 5,
  });

  return {
    accessToken,
    refreshToken,
    user: mapAuthUser(user, [roleName]),
    verificationToken,
  };
}

export async function login(payload, context = {}) {
  const identifier = payload.email || payload.username;
  if (!identifier) {
    throw new ApiError(400, "Email or username is required");
  }

  const shouldUseEmail = Boolean(payload.email || identifier.includes("@"));
  const user = shouldUseEmail
    ? await findUserByEmail(identifier)
    : await findUserByUsername(identifier);
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

  const requestUserAgent = getRequestUserAgent(context.req);
  const requestIpAddress = getRequestIpAddress(context.req);
  const requestLocationLabel = resolveDeviceLocationLabel(
    context.req,
    payload?.locationLabel,
  );
  const trustedDevice = await resolveTrustedDeviceForLogin(
    user.id,
    payload?.trustedDeviceToken,
  );

  if (user.twoFactorEnabled && user.twoFactorSecret && !trustedDevice.trusted) {
    return {
      requires_2fa: true,
      pre_auth_token: signPreAuthToken(buildTokenPayload(user)),
      user: mapAuthUser(user),
    };
  }

  const accessToken = signAccessToken(buildTokenPayload(user));
  const refreshToken = signRefreshToken(buildTokenPayload(user));
  const refreshTokenHash = await hashToken(refreshToken);

  await updateUser(user.id, { refreshTokenHash });
  const deviceName = payload?.deviceName || buildDeviceName(requestUserAgent);
  const { trustedDeviceToken, isNewDevice } = await registerTrustedDevice(user.id, {
    deviceIdentifier: payload?.deviceIdentifier,
    deviceName,
    userAgent: requestUserAgent,
    ipAddress: requestIpAddress,
    locationLabel: requestLocationLabel,
  });

  if (isNewDevice) {
    await notifyNewDeviceLogin(user.id, {
      deviceName,
      locationLabel: requestLocationLabel,
      ipAddress: requestIpAddress,
      provider: "password",
    });
  }

  await recordActivityEvent({
    eventType: "AUTH_LOGIN",
    userId: user.id,
    metadata: {
      method:
        user.twoFactorEnabled && user.twoFactorSecret
          ? "trusted_device"
          : "password",
      device: deviceName,
      location: requestLocationLabel,
      ipAddress: requestIpAddress,
    },
    dedupeWindowSeconds: 5,
  });

  return {
    accessToken,
    refreshToken,
    trustedDeviceToken,
    user: mapAuthUser(user),
  };
}

export async function googleAuth(payload, context = {}) {
  const profile = await verifyGoogleIdToken(payload.idToken);
  const roleName =
    payload.mode === "instructor" ? "EDUCATOR" : "LEARNER";
  const existingUser = await findUserByEmail(profile.email);

  if (payload.intent === "login") {
    if (!existingUser) {
      throw new ApiError(
        404,
        "No account found for this Google email. Please register first.",
      );
    }
    if (existingUser.deletedAt || !existingUser.isActive) {
      throw new ApiError(403, "Account disabled");
    }

    const requestUserAgent = getRequestUserAgent(context.req);
    const requestIpAddress = getRequestIpAddress(context.req);
    const requestLocationLabel = resolveDeviceLocationLabel(
      context.req,
      payload?.locationLabel,
    );
    const trustedDevice = await resolveTrustedDeviceForLogin(
      existingUser.id,
      payload?.trustedDeviceToken,
    );

    if (existingUser.twoFactorEnabled && existingUser.twoFactorSecret && !trustedDevice.trusted) {
      return {
        requires_2fa: true,
        pre_auth_token: signPreAuthToken(buildTokenPayload(existingUser)),
        user: mapAuthUser(existingUser),
      };
    }

    const accessToken = signAccessToken(buildTokenPayload(existingUser));
    const refreshToken = signRefreshToken(buildTokenPayload(existingUser));
    const refreshTokenHash = await hashToken(refreshToken);
    await updateUser(existingUser.id, { refreshTokenHash });
    const deviceName = payload?.deviceName || buildDeviceName(requestUserAgent);
    const { trustedDeviceToken, isNewDevice } = await registerTrustedDevice(existingUser.id, {
      deviceIdentifier: payload?.deviceIdentifier,
      deviceName,
      userAgent: requestUserAgent,
      ipAddress: requestIpAddress,
      locationLabel: requestLocationLabel,
    });

    if (isNewDevice) {
      await notifyNewDeviceLogin(existingUser.id, {
        deviceName,
        locationLabel: requestLocationLabel,
        ipAddress: requestIpAddress,
        provider: "google",
      });
    }

    await recordActivityEvent({
      eventType: "AUTH_LOGIN",
      userId: existingUser.id,
      metadata: {
        provider: "google",
        method:
          existingUser.twoFactorEnabled && existingUser.twoFactorSecret
            ? "trusted_device"
            : "google",
        device: deviceName,
        location: requestLocationLabel,
        ipAddress: requestIpAddress,
      },
      dedupeWindowSeconds: 5,
    });

    return {
      accessToken,
      refreshToken,
      trustedDeviceToken,
      user: mapAuthUser(existingUser),
    };
  }

  if (existingUser) {
    throw new ApiError(
      409,
      "An account with this email already exists. Please log in with Google.",
    );
  }

  const defaultRole = await ensureDefaultRole(roleName);
  const username = await generateUniqueUsername(profile.email);
  const passwordHash = await hashPassword(randomToken(40));

  const user = await createUser({
    email: profile.email,
    username,
    firstName: profile.givenName || null,
    lastName: profile.familyName || null,
    passwordHash,
    verificationToken: null,
    emailVerifiedAt: new Date(),
    roles: {
      create: [{ roleId: defaultRole.id }],
    },
  });

  const tokenPayload = {
    sub: user.id,
    email: user.email,
    roles: [roleName],
  };
  const accessToken = signAccessToken(tokenPayload);
  const refreshToken = signRefreshToken(tokenPayload);
  const refreshTokenHash = await hashToken(refreshToken);
  await updateUser(user.id, { refreshTokenHash });

  await recordActivityEvent({
    eventType: "AUTH_REGISTER",
    userId: user.id,
    metadata: { role: roleName, provider: "google" },
    dedupeWindowSeconds: 5,
  });

  return {
    accessToken,
    refreshToken,
    user: mapAuthUser(user, [roleName]),
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
