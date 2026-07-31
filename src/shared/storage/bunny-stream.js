import { env } from "../config/env.js";
import { createHash } from "crypto";
import { isIP } from "node:net";

const BUNNY_STREAM_BASE_URL = "https://video.bunnycdn.com";

function normalizePullZoneHost(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  if (/^https?:\/\//i.test(raw)) {
    try {
      return new URL(raw).host;
    } catch (_error) {
      return "";
    }
  }

  if (raw.includes(".")) {
    return raw;
  }

  return `${raw}.b-cdn.net`;
}

export function isBunnyStreamEnabled() {
  return Boolean(env.streamApiKey && env.streamLibraryId && env.streamPullZone);
}

function getBunnyHeaders(extra = {}) {
  return {
    AccessKey: env.streamApiKey,
    ...extra,
  };
}

export function buildBunnyPlaybackUrl(videoId) {
  const id = String(videoId || "").trim();
  if (!id) {
    throw new Error("Bunny Stream video id is required");
  }

  const host = normalizePullZoneHost(env.streamPullZone);
  if (!host) {
    throw new Error("STREAM_PULL_ZONE is not configured");
  }

  return `https://${host}/${id}/play_720p.mp4`;
}

export function extractBunnyVideoIdFromPlaybackUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";

  try {
    const parsed = new URL(raw);
    const host = parsed.host.toLowerCase();
    const expectedHost = normalizePullZoneHost(
      env.streamPullZone,
    ).toLowerCase();
    if (!expectedHost || host !== expectedHost) {
      return "";
    }
    const [id] = parsed.pathname.split("/").filter(Boolean);
    return String(id || "").trim();
  } catch (_error) {
    return "";
  }
}

function normalizeIpv4Address(value) {
  const raw = String(value || "")
    .trim()
    .split(",")[0]
    .trim();
  if (!raw) return "";
  const unwrapped = raw.replace(/^\[|\]$/g, "");
  if (unwrapped === "::1" || unwrapped.toLowerCase() === "localhost") {
    return "127.0.0.1";
  }
  const normalized = unwrapped.startsWith("::ffff:")
    ? unwrapped.slice("::ffff:".length)
    : unwrapped;
  const withOptionalPort = normalized.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  const candidate = withOptionalPort ? withOptionalPort[1] : normalized;
  const parts = candidate.split(".");
  if (parts.length !== 4) return "";
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return "";
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return "";
  }
  return candidate;
}

function normalizeIpAddressForToken(value) {
  const raw = String(value || "")
    .trim()
    .split(",")[0]
    .trim();
  if (!raw) return "";

  const unwrapped = raw.replace(/^\[|\]$/g, "");
  if (unwrapped === "::1" || unwrapped.toLowerCase() === "localhost") {
    return "127.0.0.1";
  }

  const normalizedIpv4 = normalizeIpv4Address(unwrapped);
  if (normalizedIpv4) return normalizedIpv4;

  const normalized = unwrapped.startsWith("::ffff:")
    ? unwrapped.slice("::ffff:".length)
    : unwrapped;

  return isIP(normalized) ? normalized : "";
}

export function buildBunnySignedEmbedUrl(
  videoId,
  { ttlSeconds = 300, userIp = "" } = {},
) {
  console.log("userIp", userIp);
  const id = String(videoId || "").trim();
  if (!id) return "";

  const libraryId = String(env.streamLibraryId || "").trim();
  if (!libraryId) return "";

  const expires =
    Math.floor(Date.now() / 1000) + Math.max(30, Number(ttlSeconds) || 300);
  const baseUrl = `https://iframe.mediadelivery.net/embed/${encodeURIComponent(libraryId)}/${encodeURIComponent(id)}`;

  const tokenKey = String(env.streamTokenKey || "").trim();
  if (!tokenKey) {
    return `${baseUrl}?autoplay=false&loop=false&muted=false&preload=true&responsive=true`;
  }

  const normalizedIp = normalizeIpAddressForToken(userIp);
  if (env.streamTokenIpValidation && !normalizedIp) {
    return "";
  }

  const token = createHash("sha256")
    .update(
      env.streamTokenIpValidation
        ? `${tokenKey}${id}${expires}${normalizedIp}`
        : `${tokenKey}${id}${expires}`,
    )
    .digest("hex");

  return `${baseUrl}?token=${encodeURIComponent(token)}&expires=${encodeURIComponent(String(expires))}&autoplay=false&loop=false&muted=false&preload=true&responsive=true`;
}

export async function createBunnyStreamVideo({ title }) {
  const response = await fetch(
    `${BUNNY_STREAM_BASE_URL}/library/${encodeURIComponent(env.streamLibraryId)}/videos`,
    {
      method: "POST",
      headers: getBunnyHeaders({
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({
        title: String(title || "Course video").slice(0, 120),
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Bunny Stream create video failed (${response.status})`);
  }

  const payload = await response.json();
  const videoId = String(payload?.guid || payload?.videoId || "").trim();
  if (!videoId) {
    throw new Error("Bunny Stream did not return a video id");
  }
  return videoId;
}

export async function uploadVideoToBunnyStream({
  videoId,
  fileBuffer,
  contentType,
}) {
  const response = await fetch(
    `${BUNNY_STREAM_BASE_URL}/library/${encodeURIComponent(env.streamLibraryId)}/videos/${encodeURIComponent(videoId)}`,
    {
      method: "PUT",
      headers: getBunnyHeaders({
        "Content-Type": contentType || "application/octet-stream",
      }),
      body: fileBuffer,
    },
  );

  if (!response.ok) {
    throw new Error(`Bunny Stream upload failed (${response.status})`);
  }
}

export async function deleteBunnyStreamVideo(videoId) {
  const id = String(videoId || "").trim();
  if (!id) return;

  const response = await fetch(
    `${BUNNY_STREAM_BASE_URL}/library/${encodeURIComponent(env.streamLibraryId)}/videos/${encodeURIComponent(id)}`,
    {
      method: "DELETE",
      headers: getBunnyHeaders(),
    },
  );

  if (!response.ok && response.status !== 404) {
    throw new Error(`Bunny Stream delete failed (${response.status})`);
  }
}
