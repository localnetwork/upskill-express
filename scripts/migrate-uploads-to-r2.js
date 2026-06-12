import fs from "fs/promises";
import path from "path";
import { env } from "../src/shared/config/env.js";
import { prisma } from "../src/shared/database/prisma.js";
import { buildR2PublicUrl, isR2Enabled, normalizeObjectKey, uploadLocalFileToR2 } from "../src/shared/storage/r2.js";

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

function isLikelyLocalUploadPath(value) {
  const normalized = String(value || "").replace(/\\/g, "/").toLowerCase();
  return normalized.includes("/uploads/") || normalized.startsWith("uploads/");
}

function extractUploadsRelativePath(value) {
  const normalized = String(value || "").replace(/\\/g, "/");
  const marker = "/uploads/";
  const markerIndex = normalized.toLowerCase().indexOf(marker);

  if (markerIndex >= 0) {
    return normalizeObjectKey(normalized.slice(markerIndex + marker.length));
  }

  if (normalized.toLowerCase().startsWith("uploads/")) {
    return normalizeObjectKey(normalized.slice("uploads/".length));
  }

  if (!normalized) {
    return "";
  }

  return normalizeObjectKey(path.posix.basename(normalized));
}

async function readAllFiles(dirPath) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const absolutePath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        return readAllFiles(absolutePath);
      }
      if (entry.isFile()) {
        return [absolutePath];
      }
      return [];
    }),
  );
  return nested.flat();
}

async function uploadLocalDirectory() {
  const uploadRoot = path.resolve(env.uploadDir);
  const files = await readAllFiles(uploadRoot);
  const uploaded = new Map();
  let totalUploaded = 0;

  for (const localPath of files) {
    const relativePath = path.relative(uploadRoot, localPath).replace(/\\/g, "/");
    const objectKey = normalizeObjectKey(path.posix.join("uploads", relativePath));
    const result = await uploadLocalFileToR2(localPath, objectKey);
    uploaded.set(relativePath, result.url);
    uploaded.set(path.posix.basename(relativePath), result.url);
    totalUploaded += 1;
    console.log(`Uploaded: ${relativePath} -> ${result.url}`);
  }

  return { uploaded, totalUploaded };
}

function toMigratedUrl(value, uploadedMap) {
  if (!value || isHttpUrl(value) || !isLikelyLocalUploadPath(value)) {
    return null;
  }

  const relativePath = extractUploadsRelativePath(value);
  if (!relativePath) {
    return null;
  }

  const fromMap = uploadedMap.get(relativePath) || uploadedMap.get(path.posix.basename(relativePath));
  if (fromMap) {
    return fromMap;
  }

  return buildR2PublicUrl(path.posix.join("uploads", relativePath));
}

async function migrateMediaRows(uploadedMap) {
  const mediaRows = await prisma.media.findMany({
    select: { id: true, storagePath: true },
  });

  let updated = 0;
  for (const row of mediaRows) {
    const nextPath = toMigratedUrl(row.storagePath, uploadedMap);
    if (!nextPath || nextPath === row.storagePath) {
      continue;
    }

    await prisma.media.update({
      where: { id: row.id },
      data: { storagePath: nextPath },
    });
    updated += 1;
  }

  return updated;
}

async function migrateLessonRows(uploadedMap) {
  const lessons = await prisma.lesson.findMany({
    select: { id: true, videoUrl: true, resourceUrl: true },
  });

  let updated = 0;
  for (const lesson of lessons) {
    const nextVideoUrl = toMigratedUrl(lesson.videoUrl, uploadedMap);
    const nextResourceUrl = toMigratedUrl(lesson.resourceUrl, uploadedMap);
    if (!nextVideoUrl && !nextResourceUrl) {
      continue;
    }

    const data = {};
    if (nextVideoUrl && nextVideoUrl !== lesson.videoUrl) {
      data.videoUrl = nextVideoUrl;
    }
    if (nextResourceUrl && nextResourceUrl !== lesson.resourceUrl) {
      data.resourceUrl = nextResourceUrl;
    }
    if (!Object.keys(data).length) {
      continue;
    }

    await prisma.lesson.update({
      where: { id: lesson.id },
      data,
    });
    updated += 1;
  }

  return updated;
}

async function main() {
  if (!isR2Enabled()) {
    throw new Error("Cloudflare R2 environment variables are missing");
  }

  const uploadRoot = path.resolve(env.uploadDir);
  const stat = await fs.stat(uploadRoot);
  if (!stat.isDirectory()) {
    throw new Error(`Upload directory does not exist: ${uploadRoot}`);
  }

  const { uploaded: uploadedMap, totalUploaded } = await uploadLocalDirectory();
  const [mediaUpdated, lessonsUpdated] = await Promise.all([
    migrateMediaRows(uploadedMap),
    migrateLessonRows(uploadedMap),
  ]);

  console.log(`Completed migration. Uploaded files: ${totalUploaded}`);
  console.log(`Updated media rows: ${mediaUpdated}`);
  console.log(`Updated lesson rows: ${lessonsUpdated}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
