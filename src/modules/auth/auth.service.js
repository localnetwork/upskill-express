import { prisma } from "../../shared/database/prisma.js";
import { startTrialIfEligible } from "../access/trial.service.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import {
  signAccessToken,
  signPreAuthToken,
  signRefreshToken,
  verifyRefreshToken,
} from "../../shared/utils/jwt.js";
import { compareToken, hashToken } from "../../shared/utils/security.js";
import { mapPermissionsFromRoles } from "../../shared/utils/rolePermissions.js";
import {
  createUser,
  findUserByEmail,
  findUserById,
  findUserByUsername,
  updateUser,
} from "./auth.repository.js";
import { recordActivityEvent } from "../analytics/analytics.service.js";
import { env } from "../../shared/config/env.js";
import axios from "axios";
import {
  buildUploadsObjectKey,
  isR2Enabled,
  uploadBufferToR2,
} from "../../shared/storage/r2.js";
import {
  buildDeviceName,
  getRequestIpAddress,
  getRequestUserAgent,
  notifyNewDeviceLogin,
  registerTrustedDevice,
  resolveDeviceLocationLabel,
  resolveTrustedDeviceForLogin,
} from "./trusted-device.service.js";
import { OTP_PURPOSE, consumeOtp, issueOtp } from "./otp.service.js";

const USER_PICTURE_KEY_PREFIX = "profile_picture::";

function getRoles(user) {
  return (user.roles || []).map((item) => item.role.name);
}

export function mapAuthUser(user, roles = getRoles(user), userPicture = null) {
  const permissions = mapPermissionsFromRoles(roles);
  return {
    id: user.id,
    email: user.email,
    username: user.username,
    fullName: user.fullName || "",
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
    user_picture: userPicture,
    roles,
    permissions,
  };
}

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

async function getUserProfilePicture(userId) {
  const setting = await prisma.platformSetting.findUnique({
    where: { key: getUserPictureSettingKey(userId) },
    select: { value: true },
  });

  const parsed = safeParseJson(setting?.value);
  const mediaId = String(
    parsed?.mediaId || parsed?.id || setting?.value || "",
  ).trim();
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

const AVATAR_EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
};

// Copies the Google avatar into R2; falls back to the remote URL if R2 is off or the copy fails.
async function copyAvatarToR2(userId, pictureUrl) {
  const fallback = { storagePath: pictureUrl, mimeType: "image/jpeg", size: 0 };
  if (!isR2Enabled()) return fallback;
  try {
    const response = await axios.get(pictureUrl, {
      responseType: "arraybuffer",
      timeout: 8000,
      maxContentLength: 5 * 1024 * 1024,
    });
    const mimeType = String(response.headers["content-type"] || "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    const ext = AVATAR_EXTENSIONS[mimeType];
    if (!ext) return fallback;
    const buffer = Buffer.from(response.data);
    const uploaded = await uploadBufferToR2({
      buffer,
      objectKey: buildUploadsObjectKey(
        `avatars/${userId}-${Date.now()}.${ext}`,
      ),
      contentType: mimeType,
    });
    return { storagePath: uploaded.url, mimeType, size: buffer.length };
  } catch (error) {
    console.error("[auth] failed to copy Google avatar to R2", error.message);
    return fallback;
  }
}

// Links the Google avatar as the profile picture for a newly registered account. Never throws.
async function setGoogleProfilePicture(userId, pictureUrl) {
  if (!pictureUrl) return null;
  try {
    const stored = await copyAvatarToR2(userId, pictureUrl);
    const media = await prisma.media.create({
      data: {
        userId,
        storagePath: stored.storagePath,
        originalName: "google-profile-picture",
        mimeType: stored.mimeType,
        mediaType: "IMAGE",
        sizeInBytes: stored.size,
      },
    });
    const value = JSON.stringify({ mediaId: media.id });
    const key = getUserPictureSettingKey(userId);
    await prisma.platformSetting.upsert({
      where: { key },
      create: { key, value, description: `Profile picture for user ${userId}` },
      update: { value },
    });
    return { id: media.id, path: media.storagePath, title: media.originalName };
  } catch (error) {
    console.error("[auth] failed to set Google profile picture", error);
    return null;
  }
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
  if (value === "2" || value === "EDUCATOR" || value === "INSTRUCTOR")
    return "EDUCATOR";
  if (value === "3" || value === "LEARNER" || value === "STUDENT")
    return "LEARNER";
  return "LEARNER";
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function maskEmail(email) {
  const [local = "", domain = ""] = String(email).split("@");
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}${"*".repeat(Math.max(local.length - visible.length, 2))}@${domain}`;
}

function normalizeGoogleProfile(data) {
  const givenName = data?.given_name ? String(data.given_name).trim() : "";
  const familyName = data?.family_name ? String(data.family_name).trim() : "";
  const name = data?.name ? String(data.name).trim() : "";
  return {
    email: normalizeEmail(data?.email),
    emailVerified: String(data?.email_verified || "").toLowerCase() === "true",
    fullName: name || [givenName, familyName].filter(Boolean).join(" "),
    picture: /^https:\/\//i.test(String(data?.picture || ""))
      ? String(data.picture).trim()
      : "",
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

function assertAccountActive(user) {
  if (user.deletedAt || !user.isActive) {
    throw new ApiError(403, "Account disabled");
  }
}

function hasTwoFactor(user) {
  return Boolean(user.twoFactorEnabled && user.twoFactorSecret);
}

// Issues tokens, remembers the device and records the login activity.
async function createSession(
  user,
  { payload = {}, context = {}, provider, method, notifyNewDevice = true },
) {
  const requestUserAgent = getRequestUserAgent(context.req);
  const requestIpAddress = getRequestIpAddress(context.req);
  const requestLocationLabel = resolveDeviceLocationLabel(
    context.req,
    payload?.locationLabel,
  );

  const tokenPayload = buildTokenPayload(user);
  const accessToken = signAccessToken(tokenPayload);
  const refreshToken = signRefreshToken(tokenPayload);
  const refreshTokenHash = await hashToken(refreshToken);
  await updateUser(user.id, { refreshTokenHash });

  const deviceName = payload?.deviceName || buildDeviceName(requestUserAgent);
  const { trustedDeviceToken, isNewDevice } = await registerTrustedDevice(
    user.id,
    {
      deviceIdentifier: payload?.deviceIdentifier,
      deviceName,
      userAgent: requestUserAgent,
      ipAddress: requestIpAddress,
      locationLabel: requestLocationLabel,
    },
  );

  if (isNewDevice && notifyNewDevice) {
    await notifyNewDeviceLogin(user.id, {
      deviceName,
      locationLabel: requestLocationLabel,
      ipAddress: requestIpAddress,
      userAgent: requestUserAgent,
      provider,
    });
  }

  await recordActivityEvent({
    eventType: "AUTH_LOGIN",
    userId: user.id,
    metadata: {
      ...(provider === "google" ? { provider: "google" } : {}),
      method,
      device: deviceName,
      location: requestLocationLabel,
      ipAddress: requestIpAddress,
    },
    dedupeWindowSeconds: 5,
  });

  const userPicture = await getUserProfilePicture(user.id);

  return {
    accessToken,
    refreshToken,
    trustedDeviceToken,
    user: mapAuthUser(user, getRoles(user), userPicture),
  };
}

// Returns a pre-auth challenge when the user must pass 2FA, otherwise null.
async function twoFactorChallengeFor(user, trustedDeviceToken) {
  if (!hasTwoFactor(user)) return null;
  const trustedDevice = await resolveTrustedDeviceForLogin(
    user.id,
    trustedDeviceToken,
  );
  if (trustedDevice.trusted) return null;

  const userPicture = await getUserProfilePicture(user.id);
  return {
    requires_2fa: true,
    pre_auth_token: signPreAuthToken(buildTokenPayload(user)),
    user: mapAuthUser(user, getRoles(user), userPicture),
  };
}

export async function requestRegistrationCode(payload) {
  const email = normalizeEmail(payload.email);
  const existing = await findUserByEmail(email);
  if (existing) {
    throw new ApiError(409, "Email already in use");
  }

  const fullName = String(payload.fullName || "").trim();
  const role = normalizeRole(payload.role);
  await ensureDefaultRole(role);

  const { expiresInSeconds } = await issueOtp({
    email,
    purpose: OTP_PURPOSE.REGISTER,
    payload: { fullName, role },
    fullName,
  });

  return { email, maskedEmail: maskEmail(email), expiresInSeconds };
}

export async function verifyRegistration(payload, context = {}) {
  const email = normalizeEmail(payload.email);
  const otp = await consumeOtp({
    email,
    purpose: OTP_PURPOSE.REGISTER,
    code: payload.code,
  });

  if (await findUserByEmail(email)) {
    throw new ApiError(409, "Email already in use");
  }

  const roleName = normalizeRole(otp.payload?.role);
  const defaultRole = await ensureDefaultRole(roleName);
  const username = await generateUniqueUsername(email);

  const created = await createUser({
    email,
    username,
    fullName: otp.payload?.fullName || null,
    emailVerifiedAt: new Date(),
    roles: {
      create: [{ roleId: defaultRole.id }],
    },
  });
  const user = await findUserById(created.id);

  await recordActivityEvent({
    eventType: "AUTH_REGISTER",
    userId: user.id,
    metadata: { role: roleName },
    dedupeWindowSeconds: 5,
  });

  await startTrialIfEligible(user.id, {
    ipAddress: context.req ? getRequestIpAddress(context.req) : null,
  });

  return createSession(user, {
    payload,
    context,
    provider: "email_code",
    method: "email_code",
    notifyNewDevice: false,
  });
}

export async function login(payload, context = {}) {
  const identifier = String(payload.email || payload.username || "").trim();
  if (!identifier) {
    throw new ApiError(400, "Email is required");
  }

  const user = identifier.includes("@")
    ? await findUserByEmail(normalizeEmail(identifier))
    : await findUserByUsername(identifier);
  if (!user || user.deletedAt) {
    throw new ApiError(404, "No account found for this email. Please sign up.");
  }
  assertAccountActive(user);

  const challenge = await twoFactorChallengeFor(
    user,
    payload?.trustedDeviceToken,
  );
  if (challenge) return challenge;

  if (hasTwoFactor(user)) {
    return createSession(user, {
      payload,
      context,
      provider: "trusted_device",
      method: "trusted_device",
    });
  }

  const { expiresInSeconds } = await issueOtp({
    email: user.email,
    purpose: OTP_PURPOSE.LOGIN,
    userId: user.id,
    fullName: user.fullName,
  });

  return {
    requires_email_code: true,
    email: user.email,
    masked_email: maskEmail(user.email),
    expires_in: expiresInSeconds,
  };
}

export async function verifyLoginCode(payload, context = {}) {
  const email = normalizeEmail(payload.email);
  const user = await findUserByEmail(email);
  if (!user || user.deletedAt) {
    throw new ApiError(400, "Invalid or expired code");
  }
  assertAccountActive(user);
  if (hasTwoFactor(user)) {
    throw new ApiError(400, "Use your authenticator app to sign in");
  }

  await consumeOtp({
    email,
    purpose: OTP_PURPOSE.LOGIN,
    code: payload.code,
    userId: user.id,
  });

  if (!user.emailVerifiedAt) {
    await updateUser(user.id, { emailVerifiedAt: new Date() });
  }

  return createSession(user, {
    payload,
    context,
    provider: "email_code",
    method: "email_code",
  });
}

export async function googleAuth(payload, context = {}) {
  const profile = await verifyGoogleIdToken(payload.idToken);
  const roleName = payload.mode === "instructor" ? "EDUCATOR" : "LEARNER";
  const existingUser = await findUserByEmail(profile.email);

  if (payload.intent === "login") {
    if (!existingUser) {
      throw new ApiError(
        404,
        "No account found for this Google email. Please register first.",
      );
    }
    assertAccountActive(existingUser);

    if (!existingUser.emailVerifiedAt) {
      // Google already verified this address.
      await updateUser(existingUser.id, { emailVerifiedAt: new Date() });
      existingUser.emailVerifiedAt = new Date();
    }

    const challenge = await twoFactorChallengeFor(
      existingUser,
      payload?.trustedDeviceToken,
    );
    if (challenge) return challenge;

    return createSession(existingUser, {
      payload,
      context,
      provider: "google",
      method: hasTwoFactor(existingUser) ? "trusted_device" : "google",
    });
  }

  if (existingUser) {
    throw new ApiError(
      409,
      "An account with this email already exists. Please log in with Google.",
    );
  }

  const defaultRole = await ensureDefaultRole(roleName);
  const username = await generateUniqueUsername(profile.email);

  const created = await createUser({
    email: profile.email,
    username,
    fullName: profile.fullName || null,
    emailVerifiedAt: new Date(),
    roles: {
      create: [{ roleId: defaultRole.id }],
    },
  });
  const user = await findUserById(created.id);

  await recordActivityEvent({
    eventType: "AUTH_REGISTER",
    userId: user.id,
    metadata: { role: roleName, provider: "google" },
    dedupeWindowSeconds: 5,
  });

  const session = await createSession(user, {
    payload,
    context,
    provider: "google",
    method: "google",
    notifyNewDevice: false,
  });

  const userPicture = await setGoogleProfilePicture(user.id, profile.picture);
  session.user.user_picture = userPicture;

  await startTrialIfEligible(user.id, {
    ipAddress: getRequestIpAddress(context.req),
  });

  return session;
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
