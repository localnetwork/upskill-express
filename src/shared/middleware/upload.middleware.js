import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";
import multer from "multer";
import { env } from "../config/env.js";
import { buildUploadsObjectKey, deleteObjectFromR2, isR2Enabled, uploadLocalFileToR2 } from "../storage/r2.js";

const uploadPath = path.resolve(env.uploadDir);
if (!fs.existsSync(uploadPath)) {
  fs.mkdirSync(uploadPath, { recursive: true });
}

function generateFileName(originalName) {
  const safeOriginal = String(originalName || "file").replace(/[^\w.\-]/g, "_");
  const suffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
  return `${suffix}-${safeOriginal}`;
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

const storage = isR2Enabled() ? new R2StorageEngine() : diskStorage;

export const upload = multer({
  storage,
  limits: {
    fileSize: 500 * 1024 * 1024,
  },
});
