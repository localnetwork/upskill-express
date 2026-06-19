import DDOS from "ddos";
import { Redis } from "@upstash/redis";
import { env } from "../config/env.js";
import { ApiError } from "../utils/ApiError.js";

let redisClient = null;

function getRedisClient() {
  if (redisClient) return redisClient;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new ApiError(
      503,
      "DDoS ban storage is unavailable: missing Redis configuration.",
    );
  }

  redisClient = new Redis({ url, token });
  return redisClient;
}

function getClientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }

  const raw = String(req.ip || req.socket?.remoteAddress || "unknown");
  if (raw === "::1") return "127.0.0.1";
  if (raw.startsWith("::ffff:")) return raw.slice(7);
  if (raw.startsWith("[") && raw.includes("]:")) {
    return raw.slice(1, raw.lastIndexOf("]:"));
  }
  if (raw.includes(".") && /:\d+$/.test(raw)) {
    return raw.replace(/:\d+$/, "");
  }
  return raw;
}

export function createDdosProtection() {
  const redis = getRedisClient();
  const maxRequests = Math.max(1, Number(env.ddosMaxRequestsPerSec) || 10);
  const checkIntervalSeconds = Math.max(
    1,
    Math.ceil((Number(env.ddosCheckIntervalMs) || 1000) / 1000),
  );
  const banSeconds = Math.max(1, Number(env.ddosBanSeconds) || 300);
  const banPrefix = "ddos:ban:ip";

  const ddos = new DDOS({
    burst: maxRequests,
    limit: maxRequests,
    maxcount: maxRequests * 2,
    checkinterval: checkIntervalSeconds,
    includeUserAgent: false,
    responseStatus: 429,
    errormessage: JSON.stringify({
      message: "Too many requests. Please try again shortly.",
      retryAfter: banSeconds,
    }),
    onDenial: async (req) => {
      const ip = getClientIp(req);
      const key = `${banPrefix}:${ip}`;
      try {
        await redis.set(key, "1", { ex: banSeconds });
      } catch (error) {
        console.error("Failed to persist DDoS ban key", error);
      }
    },
  });

  return async function ddosProtection(req, res, next) {
    const ip = getClientIp(req);
    const key = `${banPrefix}:${ip}`;

    try {
      const ttl = Number(await redis.ttl(key));
      if (ttl > 0) {
        return res.status(429).json({
          message: "Too many requests. Please try again shortly.",
          retryAfter: ttl,
        });
      }
    } catch (error) {
      return next(
        new ApiError(503, "Unable to read DDoS ban storage.", {
          reason: error?.message || "unknown",
        }),
      );
    }

    return ddos.express(req, res, next);
  };
}
