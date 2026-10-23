import crypto from "crypto";
import { env } from "../config/env.js";

const BUNNY_API_BASE_URL = "https://video.bunnycdn.com";
const BUNNY_TUS_ENDPOINT = `${BUNNY_API_BASE_URL}/tusupload`;
const BUNNY_EMBED_BASE_URL = "https://iframe.mediadelivery.net/embed";
const GUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const sha256Hex = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");

export function isBunnyStreamEnabled() {
  return Boolean(env.streamApiKey && env.streamLibraryId);
}

function assertConfigured() {
  if (!isBunnyStreamEnabled()) {
    throw new Error(
      "Bunny Stream is not configured (missing STREAM_API_KEY or STREAM_LIBRARY_ID)",
    );
  }
}

function getPullZoneHost() {
  const raw = String(env.streamPullZone || "")
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "");
  if (!raw) return "";
  return raw.includes(".") ? raw : `${raw}.b-cdn.net`;
}

function apiHeaders(extra = {}) {
  return { AccessKey: env.streamApiKey, accept: "application/json", ...extra };
}

export function buildBunnyPlaybackUrl(videoId) {
  const id = String(videoId || "").trim();
  if (!id) throw new Error("Bunny Stream video id is required");
  const host = getPullZoneHost();
  if (!host) throw new Error("Bunny Stream pull zone is not configured (STREAM_PULL_ZONE)");
  return `https://${host}/${encodeURIComponent(id)}/playlist.m3u8`;
}

export function extractBunnyVideoIdFromPlaybackUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    const host = parsed.host.toLowerCase();
    const segments = parsed.pathname.split("/").filter(Boolean);

    if (host.endsWith("mediadelivery.net")) {
      // /embed/{libraryId}/{videoId} or /play/{libraryId}/{videoId}
      const id = segments[2] || "";
      return GUID_PATTERN.test(id) ? id : "";
    }

    const pullZoneHost = getPullZoneHost();
    if (host === pullZoneHost || host.endsWith(".b-cdn.net")) {
      const id = segments[0] || "";
      return GUID_PATTERN.test(id) ? id : "";
    }
  } catch (_error) {
    return "";
  }
  return "";
}

export function isBunnyPlaybackUrl(value) {
  return Boolean(extractBunnyVideoIdFromPlaybackUrl(value));
}

// Unsigned embed URL. Only plays when the library does not enforce embed token authentication.
export function buildBunnyEmbedUrlFromPlaybackUrl(value) {
  const id = extractBunnyVideoIdFromPlaybackUrl(value);
  if (!id || !env.streamLibraryId) return "";
  return `${BUNNY_EMBED_BASE_URL}/${encodeURIComponent(env.streamLibraryId)}/${encodeURIComponent(id)}`;
}

export function buildBunnySignedEmbedUrl(videoId, { ttlSeconds = 300 } = {}) {
  const id = String(videoId || "").trim();
  if (!id || !env.streamLibraryId) return "";
  const base = `${BUNNY_EMBED_BASE_URL}/${encodeURIComponent(env.streamLibraryId)}/${encodeURIComponent(id)}`;
  if (!env.streamTokenKey) return base;

  const expires = Math.floor(Date.now() / 1000) + Math.max(30, Number(ttlSeconds) || 300);
  const token = sha256Hex(`${env.streamTokenKey}${id}${expires}`);
  return `${base}?token=${token}&expires=${expires}`;
}

export async function createBunnyVideo(title) {
  assertConfigured();
  const response = await fetch(
    `${BUNNY_API_BASE_URL}/library/${encodeURIComponent(env.streamLibraryId)}/videos`,
    {
      method: "POST",
      headers: apiHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ title: String(title || "course-video").slice(0, 255) }),
    },
  );
  if (!response.ok) {
    throw new Error(`Bunny Stream video creation failed (${response.status})`);
  }
  const payload = await response.json();
  const guid = String(payload?.guid || "").trim();
  if (!guid) throw new Error("Bunny Stream did not return a video id");
  return guid;
}

// Signed headers a browser tus client sends to upload directly to Bunny without exposing the API key.
export function buildBunnyTusHeaders(videoId, { ttlSeconds = 24 * 60 * 60 } = {}) {
  assertConfigured();
  const expire = Math.floor(Date.now() / 1000) + Math.max(60, Number(ttlSeconds) || 86400);
  return {
    AuthorizationSignature: sha256Hex(
      `${env.streamLibraryId}${env.streamApiKey}${expire}${videoId}`,
    ),
    AuthorizationExpire: String(expire),
    VideoId: String(videoId),
    LibraryId: String(env.streamLibraryId),
  };
}

export async function createBunnyTusUpload({ title } = {}) {
  const uid = await createBunnyVideo(title);
  return {
    uploadUrl: BUNNY_TUS_ENDPOINT,
    uid,
    headers: buildBunnyTusHeaders(uid),
  };
}

export async function uploadVideoToBunnyStream({ fileBuffer, title, filename }) {
  const uid = await createBunnyVideo(title || filename);
  const response = await fetch(
    `${BUNNY_API_BASE_URL}/library/${encodeURIComponent(env.streamLibraryId)}/videos/${encodeURIComponent(uid)}`,
    {
      method: "PUT",
      headers: apiHeaders({ "Content-Type": "application/octet-stream" }),
      body: fileBuffer,
    },
  );
  if (!response.ok) {
    throw new Error(`Bunny Stream upload failed (${response.status})`);
  }
  return uid;
}

const LANGUAGE_CODES = {
  english: "en", cebuano: "ceb", bisaya: "ceb", filipino: "fil", tagalog: "tl",
  ilocano: "ilo", hiligaynon: "hil", waray: "war", spanish: "es", french: "fr",
  german: "de", portuguese: "pt", italian: "it", dutch: "nl", russian: "ru",
  japanese: "ja", korean: "ko", chinese: "zh", mandarin: "zh", arabic: "ar",
  hindi: "hi", indonesian: "id", malay: "ms", thai: "th", vietnamese: "vi",
  turkish: "tr", polish: "pl", ukrainian: "uk", bengali: "bn", urdu: "ur",
};

// Accepts "Cebuano", "ceb", "en-US", etc. and returns a lowercase language code.
export function resolveCaptionLanguage(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  if (LANGUAGE_CODES[raw]) return LANGUAGE_CODES[raw];
  if (/^[a-z]{2,3}([-_][a-z0-9]+)?$/.test(raw)) return raw.split(/[-_]/)[0];
  const firstWord = raw.split(/[\s,/(]+/)[0];
  return LANGUAGE_CODES[firstWord] || "";
}

async function getBunnyVideoStatus(videoId) {
  const response = await fetch(
    `${BUNNY_API_BASE_URL}/library/${encodeURIComponent(env.streamLibraryId)}/videos/${encodeURIComponent(videoId)}`,
    { headers: apiHeaders() },
  );
  if (!response.ok) throw new Error(`Bunny Stream status failed (${response.status})`);
  const payload = await response.json();
  // 3 = transcoded (playable), 4 = fully finished
  return Number(payload?.status);
}

async function requestBunnyTranscription(videoId, settings) {
  const response = await fetch(
    `${BUNNY_API_BASE_URL}/library/${encodeURIComponent(env.streamLibraryId)}/videos/${encodeURIComponent(videoId)}/transcribe`,
    {
      method: "POST",
      headers: apiHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(settings),
    },
  );
  return response;
}

/**
 * Queues Bunny's AI transcription once the video is encoded. The source language is the
 * course language (e.g. Cebuano); extra caption languages come from STREAM_CAPTION_LANGUAGES.
 * If Bunny rejects the source language, it is retried with auto-detection.
 */
export function triggerBunnyAutoCaption(videoId, courseLanguage) {
  const id = String(videoId || "").trim();
  if (!id || !isBunnyStreamEnabled()) return;

  const source = resolveCaptionLanguage(courseLanguage);
  const extra = String(env.streamCaptionLanguages || "")
    .split(",")
    .map((item) => resolveCaptionLanguage(item))
    .filter(Boolean);
  const targets = Array.from(new Set([source, ...extra].filter(Boolean)));

  const maxAttempts = 30;
  const retryDelayMs = 10_000;
  const wait = () => new Promise((resolve) => setTimeout(resolve, retryDelayMs));

  const run = async () => {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const status = await getBunnyVideoStatus(id);
        if (status === 5 || status === 6) return; // failed upload/encoding
        if (status < 3) {
          await wait();
          continue;
        }

        const base = { generateTitle: false, generateDescription: false };
        const withLanguage = {
          ...base,
          ...(source ? { sourceLanguage: source } : {}),
          ...(targets.length ? { targetLanguages: targets } : {}),
        };
        let response = await requestBunnyTranscription(id, withLanguage);
        if (response.status === 400 && (source || targets.length)) {
          response = await requestBunnyTranscription(id, base);
        }
        if (response.ok || response.status === 400) return; // 400 also means "already transcribed"
        throw new Error(`Bunny Stream transcription failed (${response.status})`);
      } catch (error) {
        if (attempt >= maxAttempts) {
          console.error(`Failed to auto-caption Bunny video ${id}:`, error?.message || error);
          return;
        }
        await wait();
      }
    }
  };

  void run();
}

export async function deleteBunnyStreamVideo(videoId) {
  const id = String(videoId || "").trim();
  if (!id || !isBunnyStreamEnabled()) return;
  const response = await fetch(
    `${BUNNY_API_BASE_URL}/library/${encodeURIComponent(env.streamLibraryId)}/videos/${encodeURIComponent(id)}`,
    { method: "DELETE", headers: apiHeaders() },
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(`Bunny Stream delete failed (${response.status})`);
  }
}
