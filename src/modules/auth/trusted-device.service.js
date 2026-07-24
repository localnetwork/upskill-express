import crypto from "crypto";
import { prisma } from "../../shared/database/prisma.js";
import { randomToken } from "../../shared/utils/security.js";

const MAX_ACTIVE_TRUSTED_DEVICES = 20;
const TRUSTED_DEVICE_TTL_DAYS = 45;

function toTrimmed(value) {
  return String(value || "").trim();
}

function getHeaderValue(req, headerName) {
  return toTrimmed(req?.headers?.[headerName]);
}

function normalizeIpAddress(value) {
  const forwarded = toTrimmed(value);
  if (!forwarded) return "";
  return forwarded.split(",")[0].trim();
}

export function getRequestIpAddress(req) {
  const fromForwarded = normalizeIpAddress(req?.headers?.["x-forwarded-for"]);
  if (fromForwarded) return fromForwarded;
  return toTrimmed(req?.ip || req?.socket?.remoteAddress || "unknown");
}

export function getRequestUserAgent(req) {
  return toTrimmed(req?.headers?.["user-agent"]).slice(0, 500) || "Unknown device";
}

function normalizeDeviceFamily(userAgent = "") {
  const source = String(userAgent || "").toLowerCase();

  if (source.includes("iphone")) return "iPhone";
  if (source.includes("ipad")) return "iPad";
  if (source.includes("android")) return "Android";
  if (source.includes("windows")) return "Windows";
  if (source.includes("mac os") || source.includes("macintosh")) return "Mac";
  if (source.includes("linux")) return "Linux";
  return "Unknown OS";
}

function normalizeBrowser(userAgent = "") {
  const source = String(userAgent || "").toLowerCase();
  if (source.includes("edg/")) return "Edge";
  if (source.includes("chrome/")) return "Chrome";
  if (source.includes("safari/") && !source.includes("chrome/")) return "Safari";
  if (source.includes("firefox/")) return "Firefox";
  if (source.includes("opr/") || source.includes("opera/")) return "Opera";
  return "Browser";
}

export function buildDeviceName(userAgent) {
  const deviceFamily = normalizeDeviceFamily(userAgent);
  const browser = normalizeBrowser(userAgent);
  return `${deviceFamily} • ${browser}`;
}

export function getRequestLocationLabel(req) {
  const city =
    getHeaderValue(req, "x-vercel-ip-city") ||
    getHeaderValue(req, "cf-ipcity") ||
    getHeaderValue(req, "x-city");
  const region =
    getHeaderValue(req, "x-vercel-ip-country-region") ||
    getHeaderValue(req, "cf-region") ||
    getHeaderValue(req, "x-region");
  const country =
    getHeaderValue(req, "x-vercel-ip-country") ||
    getHeaderValue(req, "cf-ipcountry") ||
    getHeaderValue(req, "x-country");

  const parts = [city, region, country].filter(Boolean);
  if (parts.length > 0) {
    return parts.join(", ").slice(0, 120);
  }

  const ipAddress = getRequestIpAddress(req);
  const normalizedIp = String(ipAddress).toLowerCase();
  if (
    normalizedIp === "127.0.0.1" ||
    normalizedIp === "::1" ||
    normalizedIp === "localhost" ||
    normalizedIp.startsWith("192.168.") ||
    normalizedIp.startsWith("10.") ||
    normalizedIp.startsWith("172.16.")
  ) {
    return "Local development";
  }
  return ipAddress ? `IP: ${ipAddress}` : "Unknown location";
}

export function resolveDeviceLocationLabel(req, clientLocationLabel) {
  const serverLocation = getRequestLocationLabel(req);
  if (
    serverLocation &&
    serverLocation !== "Unknown location" &&
    !serverLocation.startsWith("IP:")
  ) {
    return serverLocation;
  }

  const clientLocation = toTrimmed(clientLocationLabel).slice(0, 120);
  if (clientLocation) {
    return clientLocation;
  }

  return serverLocation;
}

function computeTokenDigest(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function mapTrustedDevice(device) {
  return {
    id: device.id,
    deviceName: device.deviceName,
    userAgent: device.userAgent,
    locationLabel: device.locationLabel,
    ipAddress: device.ipAddress,
    expiresAt: device.expiresAt,
    createdAt: device.createdAt,
    lastUsedAt: device.lastUsedAt,
  };
}

export async function hasActiveTrustedDeviceByIdentifier(userId, deviceIdentifier) {
  const normalizedIdentifier = toTrimmed(deviceIdentifier);
  if (!normalizedIdentifier) return false;

  const existing = await prisma.trustedDevice.findFirst({
    where: {
      userId,
      deviceIdentifier: normalizedIdentifier,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    select: { id: true },
  });
  return Boolean(existing);
}

export async function resolveTrustedDeviceForLogin(userId, trustedDeviceToken) {
  const rawToken = toTrimmed(trustedDeviceToken);
  if (!rawToken) {
    return { trusted: false, device: null };
  }

  const tokenDigest = computeTokenDigest(rawToken);
  const device = await prisma.trustedDevice.findFirst({
    where: {
      userId,
      tokenDigest,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
  });

  if (!device) {
    return { trusted: false, device: null };
  }

  await prisma.trustedDevice.update({
    where: { id: device.id },
    data: {
      lastUsedAt: new Date(),
    },
  });

  return { trusted: true, device: mapTrustedDevice(device) };
}

export async function registerTrustedDevice(userId, payload = {}) {
  const trustedDeviceToken = randomToken(40);
  const tokenDigest = computeTokenDigest(trustedDeviceToken);
  const expiresAt = new Date(Date.now() + TRUSTED_DEVICE_TTL_DAYS * 24 * 60 * 60 * 1000);
  const deviceIdentifier = toTrimmed(payload.deviceIdentifier) || null;
  const userAgent = toTrimmed(payload.userAgent).slice(0, 500) || null;
  const deviceName =
    toTrimmed(payload.deviceName).slice(0, 120) || buildDeviceName(userAgent || "");
  const ipAddress = toTrimmed(payload.ipAddress).slice(0, 100) || null;
  const locationLabel = toTrimmed(payload.locationLabel).slice(0, 120) || null;

  let device;
  if (deviceIdentifier) {
    device = await prisma.trustedDevice.findFirst({
      where: {
        userId,
        deviceIdentifier,
        revokedAt: null,
      },
    });
  }
  const isNewDevice = !device;

  if (device) {
    await prisma.trustedDevice.update({
      where: { id: device.id },
      data: {
        tokenDigest,
        userAgent,
        deviceName,
        ipAddress,
        locationLabel,
        expiresAt,
        lastUsedAt: new Date(),
      },
    });
  } else {
    await prisma.trustedDevice.create({
      data: {
        userId,
        deviceIdentifier,
        tokenDigest,
        userAgent,
        deviceName,
        ipAddress,
        locationLabel,
        expiresAt,
        lastUsedAt: new Date(),
      },
    });
  }

  const activeDevices = await prisma.trustedDevice.findMany({
    where: {
      userId,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: [{ lastUsedAt: "desc" }, { createdAt: "desc" }],
    select: { id: true },
  });

  if (activeDevices.length > MAX_ACTIVE_TRUSTED_DEVICES) {
    const staleDeviceIds = activeDevices
      .slice(MAX_ACTIVE_TRUSTED_DEVICES)
      .map((item) => item.id);
    if (staleDeviceIds.length) {
      await prisma.trustedDevice.updateMany({
        where: {
          id: { in: staleDeviceIds },
        },
        data: {
          revokedAt: new Date(),
        },
      });
    }
  }

  return { trustedDeviceToken, isNewDevice };
}

export async function listTrustedDevices(userId) {
  const devices = await prisma.trustedDevice.findMany({
    where: {
      userId,
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    orderBy: [{ lastUsedAt: "desc" }, { createdAt: "desc" }],
  });

  return devices.map(mapTrustedDevice);
}

export async function revokeTrustedDevice(userId, deviceId) {
  const device = await prisma.trustedDevice.findFirst({
    where: {
      id: deviceId,
      userId,
      revokedAt: null,
    },
    select: { id: true },
  });

  if (!device) {
    return { success: false };
  }

  await prisma.trustedDevice.update({
    where: { id: deviceId },
    data: { revokedAt: new Date() },
  });
  return { success: true };
}
