import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const envFilePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../.env",
);

dotenv.config({ path: envFilePath });

export const env = {
  nodeEnv: process.env.NODE_ENV || "development",
  port: Number(process.env.PORT || 3000),
  corsOrigin: process.env.CORS_ORIGIN || "*",
  jwtAccessSecret: process.env.JWT_ACCESS_SECRET || "access-secret",
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET || "refresh-secret",
  jwtAccessTtl: process.env.JWT_ACCESS_TTL || "15m",
  jwtRefreshTtl: process.env.JWT_REFRESH_TTL || "30d",
  paypalBaseUrl:
    process.env.PAYPAL_BASE_URL || "https://api-m.sandbox.paypal.com",
  paypalClientId: process.env.PAYPAL_CLIENT_ID || "",
  paypalClientSecret: process.env.PAYPAL_CLIENT_SECRET || "",
  frontendUrl: process.env.FRONTEND_URL || "http://localhost:3000",
  uploadDir: process.env.UPLOAD_DIR || "uploads",
  cfAccessKeyId: process.env.CF_ACCESS_KEY_ID || "",
  cfAccessSecret: process.env.CF_ACCESS_SECRET || "",
  cfEndpoint: process.env.CF_ENDPOINT || "",
  cfBucket: process.env.CF_BUCKET || "",
  cfPublicAccessUrl: process.env.CF_PUBLIC_ACCESS_URL || "",
};
