import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import crypto from "crypto";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import multer from "multer";
import { ApiError } from "../utils/ApiError.js";
import { isImageIndecent } from "../moderation/nsfw.js";
import { env } from "../config/env.js";
import { buildUploadsObjectKey, deleteObjectFromR2, isR2Enabled, uploadLocalFileToR2 } from "../storage/r2.js";

const uploadPath = path.resolve(env.uploadDir);
if (!fs.existsSync(uploadPath)) {
  fs.mkdirSync(uploadPath, { recursive: true });
}

function generateFileName(originalName) {
  const original = String(originalName || "file");
  const extension = path.extname(original).toLowerCase().replace(/[^.\w]/g, "");
  const hash = crypto
    .createHash("sha256")
    .update(`${Date.now()}-${crypto.randomBytes(16).toString("hex")}-${original}`)
    .digest("hex");
  return `${hash}${extension}`;
}

class R2StorageEngine {
  async _handleFile(_req, file, cb) {
    let tempFilePath = "";
    try {
      const filename = generateFileName(file.originalname);
      const key = buildUploadsObjectKey(filename);
      tempFilePath = path.join(uploadPath, `tmp-${filename}`);
      await pipeline(file.stream, createWriteStream(tempFilePath));

      const uploaded = await uploadLocalFileToR2(
        tempFilePath,
        key,
        file.mimetype,
      );
      const stat = await fsp.stat(tempFilePath);

      cb(null, {
        size: stat.size,
        filename,
        key: uploaded.key,
        path: uploaded.url,
        destination: "r2",
      });
    } catch (error) {
      cb(error);
    } finally {
      if (tempFilePath) {
        await fsp.unlink(tempFilePath).catch(() => {});
      }
    }
  }

  _removeFile(_req, file, cb) {
    if (!file?.key) {
      cb(null);
      return;
    }

    deleteObjectFromR2(file.key)
      .then(() => cb(null))
      .catch((error) => cb(error));
  }
}

const diskStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadPath),
  filename: (_req, file, cb) => cb(null, generateFileName(file.originalname)),
});

const baseStorage = isR2Enabled() ? new R2StorageEngine() : diskStorage;

const SCANNABLE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_SCAN_BYTES = 25 * 1024 * 1024;

// Images are buffered and scanned before reaching the real storage, so rejected files are never saved.
class NsfwModeratedStorage {
  _handleFile(req, file, cb) {
    if (!SCANNABLE_IMAGE_TYPES.has(String(file.mimetype || "").toLowerCase())) {
      return baseStorage._handleFile(req, file, cb);
    }

    const chunks = [];
    let total = 0;
    file.stream.on("data", (chunk) => {
      chunks.push(chunk);
      total += chunk.length;
    });
    file.stream.on("error", cb);
    file.stream.on("end", async () => {
      const buffer = Buffer.concat(chunks);
      if (total <= MAX_SCAN_BYTES) {
        try {
          if (await isImageIndecent(buffer)) {
            return cb(new ApiError(422, "This image appears to contain indecent content and cannot be uploaded."));
          }
        } catch (error) {
          console.error("[nsfw] scan failed, allowing upload:", error.message);
        }
      }
      baseStorage._handleFile(req, { ...file, stream: Readable.from([buffer]) }, cb);
    });
  }

  _removeFile(req, file, cb) {
    baseStorage._removeFile(req, file, cb);
  }
}

const storage = new NsfwModeratedStorage();

export const upload = multer({
  storage,
  limits: {
    fileSize: 500 * 1024 * 1024,
  },
});
