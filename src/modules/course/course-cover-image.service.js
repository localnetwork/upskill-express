import axios from "axios";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { prisma } from "../../shared/database/prisma.js";
import { env } from "../../shared/config/env.js";
import {
  buildUploadsObjectKey,
  isR2Enabled,
  uploadBufferToR2,
} from "../../shared/storage/r2.js";

const OPENVERSE_URL = "https://api.openverse.org/v1/images/";
const COMMONS_URL = "https://commons.wikimedia.org/w/api.php";
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED_TYPES = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};
const USER_AGENT = "UpskillCourseDraft/1.0 (course cover image fetcher)";

function stripHtml(value) {
  return String(value || "").replace(/<[^>]*>/g, "").trim();
}

async function searchOpenverse(query) {
  const { data } = await axios.get(OPENVERSE_URL, {
    params: {
      q: query,
      license_type: "commercial,modification",
      mature: false,
      page_size: 20,
    },
    headers: { "User-Agent": USER_AGENT },
    timeout: 12000,
  });
  return (data?.results || [])
    .filter(
      (item) =>
        item?.url &&
        (!item.width || item.width >= 800) &&
        (!item.width || !item.height || item.width >= item.height),
    )
    .map((item) => ({
      url: item.url,
      title: item.title || query,
      creator: item.creator || "",
      license: [item.license, item.license_version].filter(Boolean).join(" "),
      source: item.foreign_landing_url || item.url,
    }));
}

async function searchWikimediaCommons(query) {
  const { data } = await axios.get(COMMONS_URL, {
    params: {
      action: "query",
      format: "json",
      generator: "search",
      gsrsearch: `${query} filetype:bitmap`,
      gsrnamespace: 6,
      gsrlimit: 10,
      prop: "imageinfo",
      iiprop: "url|mime|size|extmetadata",
      iiurlwidth: 1280,
    },
    headers: { "User-Agent": USER_AGENT },
    timeout: 12000,
  });
  return Object.values(data?.query?.pages || {})
    .map((page) => {
      const info = page?.imageinfo?.[0];
      const meta = info?.extmetadata || {};
      return {
        url: info?.thumburl || info?.url,
        mime: info?.mime,
        width: info?.width || 0,
        height: info?.height || 0,
        title: stripHtml(meta.ObjectName?.value) || page?.title || query,
        creator: stripHtml(meta.Artist?.value),
        license: stripHtml(meta.LicenseShortName?.value),
        source: info?.descriptionurl || info?.url,
      };
    })
    .filter(
      (item) =>
        item.url &&
        ALLOWED_TYPES[item.mime] &&
        item.width >= 800 &&
        item.width >= item.height,
    );
}

async function downloadImage(candidate) {
  const response = await axios.get(candidate.url, {
    responseType: "arraybuffer",
    timeout: 10000,
    maxContentLength: MAX_IMAGE_BYTES,
    headers: { "User-Agent": USER_AGENT },
  });
  const contentType = String(response.headers?.["content-type"] || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const extension = ALLOWED_TYPES[contentType];
  if (!extension) return null;
  const buffer = Buffer.from(response.data);
  if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) return null;
  return { buffer, contentType, extension };
}

async function storeImage({ buffer, contentType, extension }) {
  const filename = `${crypto.randomBytes(24).toString("hex")}${extension}`;
  if (isR2Enabled()) {
    const uploaded = await uploadBufferToR2({
      buffer,
      objectKey: buildUploadsObjectKey(filename),
      contentType,
    });
    return uploaded.url;
  }
  const dir = path.resolve(env.uploadDir);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), buffer);
  return `/uploads/${filename}`;
}

/**
 * Finds a free, openly licensed image matching the query (Openverse, then
 * Wikimedia Commons), stores it, and links it to the course as its cover.
 * Never throws: returns null when no suitable image could be attached.
 */
export async function attachAICoverImage({ userId, courseId, queries }) {
  const searchTerms = Array.from(
    new Set(
      (queries || [])
        .map((q) => String(q || "").replace(/\s+/g, " ").trim().slice(0, 120))
        .filter(Boolean),
    ),
  );

  for (const query of searchTerms) {
    for (const search of [searchOpenverse, searchWikimediaCommons]) {
      let candidates = [];
      try {
        candidates = await search(query);
      } catch (_error) {
        continue;
      }
      for (const candidate of candidates.slice(0, 5)) {
        try {
          const image = await downloadImage(candidate);
          if (!image) continue;
          const storagePath = await storeImage(image);
          const attribution = [candidate.title, candidate.creator, candidate.license]
            .filter(Boolean)
            .join(" - ")
            .slice(0, 200);
          const media = await prisma.media.create({
            data: {
              userId,
              courseId,
              storagePath,
              originalName: attribution || `cover${image.extension}`,
              mimeType: image.contentType,
              mediaType: "COVER_IMAGE",
              sizeInBytes: image.buffer.length,
            },
          });
          return {
            id: media.id,
            path: media.storagePath,
            source: candidate.source,
          };
        } catch (_error) {
          continue;
        }
      }
    }
  }
  return null;
}
