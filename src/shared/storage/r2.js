import fs from "fs/promises";
import { createReadStream } from "fs";
import path from "path";
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { env } from "../config/env.js";

const R2_REGION = "auto";
const UPLOADS_PREFIX = "uploads";

let r2Client = null;

export function isR2Enabled() {
  return Boolean(env.cfAccessKeyId && env.cfAccessSecret && env.cfEndpoint && env.cfBucket);
}

export function normalizeObjectKey(input) {
  return String(input || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
}

export function buildUploadsObjectKey(fileName) {
  return normalizeObjectKey(path.posix.join(UPLOADS_PREFIX, String(fileName || "")));
}

export function buildR2PublicUrl(objectKey) {
  if (!env.cfPublicAccessUrl) {
    throw new Error("CF_PUBLIC_ACCESS_URL is required for R2 public URL generation");
  }
  return `${env.cfPublicAccessUrl.replace(/\/+$/, "")}/${normalizeObjectKey(objectKey)}`;
}

export function extractR2ObjectKeyFromStoragePath(storagePath) {
  const raw = String(storagePath || "").trim();
  if (!raw) {
    return "";
  }

  if (/^https?:\/\//i.test(raw)) {
    const asUrl = new URL(raw);
    return normalizeObjectKey(asUrl.pathname);
  }

  if (raw.startsWith("/uploads/")) {
    return normalizeObjectKey(raw.replace(/^\/+/, ""));
  }

  return normalizeObjectKey(raw);
}

export function isR2StoragePath(storagePath) {
  const raw = String(storagePath || "").trim();
  if (!raw) {
    return false;
  }

  if (!/^https?:\/\//i.test(raw)) {
    return raw.startsWith("/uploads/") || raw.startsWith("uploads/");
  }

  try {
    const target = new URL(raw);
    const allowedHosts = [env.cfPublicAccessUrl, env.cfEndpoint]
      .filter(Boolean)
      .map((value) => new URL(value).host.toLowerCase());
    return allowedHosts.includes(target.host.toLowerCase());
  } catch (_error) {
    return false;
  }
}

function getR2Client() {
  if (!isR2Enabled()) {
    throw new Error("Cloudflare R2 is not configured");
  }
  if (!r2Client) {
    r2Client = new S3Client({
      region: R2_REGION,
      endpoint: env.cfEndpoint,
      credentials: {
        accessKeyId: env.cfAccessKeyId,
        secretAccessKey: env.cfAccessSecret,
      },
      forcePathStyle: true,
    });
  }
  return r2Client;
}

export async function uploadBufferToR2({ buffer, objectKey, contentType }) {
  const key = normalizeObjectKey(objectKey);
  if (!key) {
    throw new Error("R2 object key is required");
  }

  const client = getR2Client();
  const command = new PutObjectCommand({
    Bucket: env.cfBucket,
    Key: key,
    Body: buffer,
    ContentType: contentType || "application/octet-stream",
  });
  const output = await client.send(command);
  return {
    key,
    etag: output.ETag || null,
    url: buildR2PublicUrl(key),
  };
}

export async function uploadStreamToR2({ stream, objectKey, contentType }) {
  const key = normalizeObjectKey(objectKey);
  if (!key) {
    throw new Error("R2 object key is required");
  }

  const client = getR2Client();
  const command = new PutObjectCommand({
    Bucket: env.cfBucket,
    Key: key,
    Body: stream,
    ContentType: contentType || "application/octet-stream",
  });
  const output = await client.send(command);
  return {
    key,
    etag: output.ETag || null,
    url: buildR2PublicUrl(key),
  };
}

export async function uploadLocalFileToR2(localFilePath, objectKey, contentType) {
  const key = normalizeObjectKey(objectKey);
  if (!key) {
    throw new Error("R2 object key is required");
  }

  const stat = await fs.stat(localFilePath);
  const client = getR2Client();
  const command = new PutObjectCommand({
    Bucket: env.cfBucket,
    Key: key,
    Body: createReadStream(localFilePath),
    ContentType: contentType || "application/octet-stream",
    ContentLength: stat.size,
  });
  const output = await client.send(command);
  return {
    key,
    etag: output.ETag || null,
    url: buildR2PublicUrl(key),
  };
}

export async function getObjectFromR2(storagePath) {
  const key = extractR2ObjectKeyFromStoragePath(storagePath);
  if (!key) {
    throw new Error("R2 object key is required");
  }

  const client = getR2Client();
  const output = await client.send(
    new GetObjectCommand({
      Bucket: env.cfBucket,
      Key: key,
    }),
  );

  return {
    key,
    body: output.Body,
    contentType: output.ContentType || "application/octet-stream",
    contentLength: output.ContentLength || undefined,
  };
}

export async function deleteObjectFromR2(objectKey) {
  const key = normalizeObjectKey(objectKey);
  if (!key) {
    return;
  }

  const client = getR2Client();
  await client.send(
    new DeleteObjectCommand({
      Bucket: env.cfBucket,
      Key: key,
    }),
  );
}
