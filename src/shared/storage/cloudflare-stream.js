import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

const CLOUDFLARE_STREAM_BASE_URL =
  "https://api.cloudflare.com/client/v4/accounts";
let cachedSigningKey = null;

function getCloudflareAuthHeaders(extra = {}) {
  return {
    Authorization: `Bearer ${env.cfStreamApiToken}`,
    ...extra,
  };
}

async function fetchCloudflareJson(endpoint, options = {}) {
  const response = await fetch(endpoint, options);
  let payload = null;
  try {
    payload = await response.json();
  } catch (_error) {
    payload = null;
  }
  return { response, payload };
}

export function isCloudflareStreamEnabled() {
  return Boolean(env.cfStreamAccountId && env.cfStreamApiToken);
}

export function buildCloudflarePlaybackUrl(videoId) {
  const id = String(videoId || "").trim();
  if (!id) {
    throw new Error("Cloudflare Stream video id is required");
  }
  return `https://videodelivery.net/${encodeURIComponent(id)}/manifest/video.m3u8`;
}

export function extractCloudflareVideoIdFromPlaybackUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  try {
    const parsed = new URL(raw);
    const host = parsed.host.toLowerCase();
    const pathSegments = parsed.pathname.split("/").filter(Boolean);
    if (!pathSegments.length) return "";

    const isCloudflareStreamHost =
      host.includes("videodelivery.net") || host.includes("cloudflarestream.com");
    if (!isCloudflareStreamHost) {
      return "";
    }

    const videoId = String(pathSegments[0] || "").trim();
    return videoId;
  } catch (_error) {
    return "";
  }
}

function buildCloudflareEmbedUrl(videoId) {
  const id = String(videoId || "").trim();
  if (!id) return "";
  return `https://iframe.videodelivery.net/${encodeURIComponent(id)}`;
}

function buildCloudflareEmbedUrlFromToken(token) {
  const value = String(token || "").trim();
  if (!value) return "";

  const customerCode = String(env.cfStreamCustomerCode || "").trim();
  if (customerCode) {
    return `https://customer-${encodeURIComponent(customerCode)}.cloudflarestream.com/${encodeURIComponent(value)}/iframe`;
  }
  return `https://iframe.videodelivery.net/${encodeURIComponent(value)}`;
}

export function buildCloudflareEmbedUrlFromPlaybackUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  if (/^https:\/\/iframe\.videodelivery\.net\//i.test(raw)) {
    return raw;
  }

  const videoId = extractCloudflareVideoIdFromPlaybackUrl(raw);
  if (!videoId) return "";
  return buildCloudflareEmbedUrl(videoId);
}

function normalizeCloudflareSigningKeyPem(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/BEGIN (RSA )?PRIVATE KEY/.test(raw)) {
    return raw.replace(/\\n/g, "\n");
  }

  // Support base64-encoded PEM strings from env/config secrets managers.
  if (/^[A-Za-z0-9+/=]+$/.test(raw)) {
    try {
      const decoded = Buffer.from(raw, "base64").toString("utf8").trim();
      if (/BEGIN (RSA )?PRIVATE KEY/.test(decoded)) {
        return decoded.replace(/\\n/g, "\n");
      }
    } catch (_error) {
      return "";
    }
  }

  return "";
}

function normalizeKeyRecord(candidate) {
  const id = String(candidate?.id || candidate?.uid || "").trim();
  const pem = normalizeCloudflareSigningKeyPem(candidate?.pem);
  if (!id || !pem) return null;
  return { id, pem };
}

async function requestCloudflareSigningKeyCreation() {
  const endpoint = `${CLOUDFLARE_STREAM_BASE_URL}/${encodeURIComponent(env.cfStreamAccountId)}/stream/keys`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: getCloudflareAuthHeaders(),
  });

  if (!response.ok) {
    throw new Error(`Cloudflare Stream signing key creation failed (${response.status})`);
  }

  const payload = await response.json();
  const created = normalizeKeyRecord(payload?.result);
  if (!created) {
    throw new Error("Cloudflare Stream key creation did not return id/pem");
  }
  return created;
}

async function resolveCloudflareSigningKey() {
  if (cachedSigningKey?.id && cachedSigningKey?.pem) {
    return cachedSigningKey;
  }

  const envKeyId = String(env.cfStreamSigningKeyId || "").trim();
  const envPem = normalizeCloudflareSigningKeyPem(env.cfStreamSigningKey);
  if (envKeyId && envPem) {
    cachedSigningKey = { id: envKeyId, pem: envPem };
    return cachedSigningKey;
  }

  if (!env.cfStreamAccountId || !env.cfStreamApiToken) {
    return null;
  }

  const created = await requestCloudflareSigningKeyCreation();
  cachedSigningKey = created;
  return created;
}

export async function buildCloudflareSignedEmbedUrl(
  videoId,
  { ttlSeconds = 300 } = {},
) {
  const id = String(videoId || "").trim();
  if (!id) return "";

  const embedUrl = buildCloudflareEmbedUrl(id);
  const signingKey = await resolveCloudflareSigningKey();
  if (!signingKey) return embedUrl;

  const exp = Math.floor(Date.now() / 1000) + Math.max(30, Number(ttlSeconds) || 300);
  const token = jwt.sign({ sub: id, kid: signingKey.id, exp }, signingKey.pem, {
    algorithm: "RS256",
    header: { kid: signingKey.id },
  });
  return buildCloudflareEmbedUrlFromToken(token);
}

export async function uploadVideoToCloudflareStream({
  fileBuffer,
  contentType,
  filename,
  title,
}) {
  if (!env.cfStreamAccountId || !env.cfStreamApiToken) {
    throw new Error(
      "Cloudflare Stream upload is not configured (missing CF_STREAM_ACCOUNT_ID or CF_STREAM_API_TOKEN)",
    );
  }

  const endpoint = `${CLOUDFLARE_STREAM_BASE_URL}/${encodeURIComponent(env.cfStreamAccountId)}/stream`;
  const safeName = String(filename || title || "course-video").slice(0, 120);

  const formData = new FormData();
  formData.append(
    "file",
    new Blob([fileBuffer], {
      type: contentType || "application/octet-stream",
    }),
    safeName,
  );
  formData.append("meta", JSON.stringify({ name: safeName }));

  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: getCloudflareAuthHeaders(),
      body: formData,
    });
  } catch (error) {
    throw new Error(
      `Cloudflare Stream upload request failed (${endpoint})`,
      { cause: error },
    );
  }

  if (!response.ok) {
    throw new Error(`Cloudflare Stream upload failed (${response.status})`);
  }

  const payload = await response.json();
  const videoId = String(payload?.result?.uid || "").trim();
  if (!videoId) {
    throw new Error("Cloudflare Stream did not return a video id");
  }

  return videoId;
}

export async function createCloudflareDirectUpload({
  maxDurationSeconds = 3600,
  requireSignedUrls = true,
  title,
} = {}) {
  if (!env.cfStreamAccountId || !env.cfStreamApiToken) {
    throw new Error(
      "Cloudflare Stream direct upload is not configured (missing CF_STREAM_ACCOUNT_ID or CF_STREAM_API_TOKEN)",
    );
  }

  const endpoint = `${CLOUDFLARE_STREAM_BASE_URL}/${encodeURIComponent(env.cfStreamAccountId)}/stream/direct_upload`;
  const safeMaxDuration = Math.max(1, Math.floor(Number(maxDurationSeconds) || 3600));
  const safeName = String(title || "course-video").slice(0, 120);

  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: getCloudflareAuthHeaders({
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({
        maxDurationSeconds: safeMaxDuration,
        requireSignedURLs: Boolean(requireSignedUrls),
        meta: {
          name: safeName,
        },
      }),
    });
  } catch (error) {
    throw new Error(
      `Cloudflare Stream direct upload request failed (${endpoint})`,
      { cause: error },
    );
  }

  if (!response.ok) {
    throw new Error(`Cloudflare Stream direct upload failed (${response.status})`);
  }

  const payload = await response.json();
  const uploadUrl = String(payload?.result?.uploadURL || "").trim();
  const uid = String(payload?.result?.uid || "").trim();
  if (!uploadUrl || !uid) {
    throw new Error("Cloudflare Stream direct upload did not return uploadURL or uid");
  }

  return { uploadUrl, uid };
}

async function isCloudflareVideoReady(videoId) {
  const endpoint = `${CLOUDFLARE_STREAM_BASE_URL}/${encodeURIComponent(env.cfStreamAccountId)}/stream/${encodeURIComponent(videoId)}`;
  const { response, payload } = await fetchCloudflareJson(endpoint, {
    method: "GET",
    headers: getCloudflareAuthHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Cloudflare Stream video status check failed (${response.status})`);
  }

  const readyToStream = Boolean(payload?.result?.readyToStream);
  const statusState = String(payload?.result?.status?.state || "").toLowerCase();
  return readyToStream || statusState === "ready";
}

async function listCloudflareCaptions(videoId) {
  const endpoint = `${CLOUDFLARE_STREAM_BASE_URL}/${encodeURIComponent(env.cfStreamAccountId)}/stream/${encodeURIComponent(videoId)}/captions`;
  const { response, payload } = await fetchCloudflareJson(endpoint, {
    method: "GET",
    headers: getCloudflareAuthHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Cloudflare Stream caption listing failed (${response.status})`);
  }
  return Array.isArray(payload?.result) ? payload.result : [];
}

async function generateCloudflareCaption(videoId, language) {
  const endpoint = `${CLOUDFLARE_STREAM_BASE_URL}/${encodeURIComponent(env.cfStreamAccountId)}/stream/${encodeURIComponent(videoId)}/captions/${encodeURIComponent(language)}/generate`;
  const { response } = await fetchCloudflareJson(endpoint, {
    method: "POST",
    headers: getCloudflareAuthHeaders(),
  });
  if (!response.ok) {
    throw new Error(`Cloudflare Stream caption generation failed (${response.status})`);
  }
}

async function ensureCloudflareAutoCaption(videoId, language) {
  const requestedLanguage = String(language || "en").trim().toLowerCase();
  if (!requestedLanguage) return;

  const captions = await listCloudflareCaptions(videoId);
  const alreadyExists = captions.some(
    (item) => String(item?.language || "").toLowerCase() === requestedLanguage,
  );
  if (alreadyExists) {
    return;
  }
  await generateCloudflareCaption(videoId, requestedLanguage);
}

export function triggerCloudflareAutoCaption(videoId, language) {
  if (!isCloudflareStreamEnabled()) return;

  const id = String(videoId || "").trim();
  if (!id) return;

  const requestedLanguage = String(
    language || env.cfStreamAutoCaptionLanguage || "en",
  )
    .trim()
    .toLowerCase();
  if (!requestedLanguage) return;

  const maxAttempts = 12;
  const retryDelayMs = 10_000;

  const run = async () => {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const ready = await isCloudflareVideoReady(id);
        if (!ready) {
          if (attempt < maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
            continue;
          }
          throw new Error(
            `Cloudflare video ${id} was not ready after ${maxAttempts} attempts`,
          );
        }
        await ensureCloudflareAutoCaption(id, requestedLanguage);
        return;
      } catch (error) {
        if (attempt >= maxAttempts) {
          console.error(
            `Failed to auto-generate Cloudflare caption for ${id}:`,
            error,
          );
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
    }
  };

  // Fire-and-forget background task so upload responses stay fast.
  void run();
}

export async function deleteCloudflareStreamVideo(videoId) {
  const id = String(videoId || "").trim();
  if (!id) return;

  const endpoint = `${CLOUDFLARE_STREAM_BASE_URL}/${encodeURIComponent(env.cfStreamAccountId)}/stream/${encodeURIComponent(id)}`;
  const response = await fetch(endpoint, {
    method: "DELETE",
    headers: getCloudflareAuthHeaders(),
  });

  if (!response.ok && response.status !== 404) {
    throw new Error(`Cloudflare Stream delete failed (${response.status})`);
  }
}
