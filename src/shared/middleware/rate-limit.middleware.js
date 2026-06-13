import { Redis } from "@upstash/redis";

let redisClient = null;

function getRedisClient() {
  if (redisClient) return redisClient;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;

  redisClient = new Redis({ url, token });
  return redisClient;
}

function getClientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "");
  if (forwarded) {
    return forwarded.split(",")[0].trim();
  }
  return String(req.ip || req.socket?.remoteAddress || "unknown");
}

function toIdentifier(req, by = "ip") {
  if (by === "user_or_ip") {
    return req.user?.id ? `user:${req.user.id}` : `ip:${getClientIp(req)}`;
  }
  if (by === "user") {
    return req.user?.id ? `user:${req.user.id}` : `anon`;
  }
  return `ip:${getClientIp(req)}`;
}

export function createRateLimiter(options = {}) {
  const {
    keyPrefix = "rate-limit",
    windowSeconds = 60,
    maxRequests = 100,
    by = "ip",
    message = "Too many requests",
  } = options;

  return async function rateLimitMiddleware(req, res, next) {
    const redis = getRedisClient();
    if (!redis) return next();

    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - (now % windowSeconds);
    const resetAt = windowStart + windowSeconds;
    const identifier = toIdentifier(req, by);
    const key = `${keyPrefix}:${identifier}:${windowStart}`;

    try {
      const count = Number(await redis.incr(key));
      if (count === 1) {
        await redis.expire(key, windowSeconds + 1);
      }

      const remaining = Math.max(0, maxRequests - count);
      res.setHeader("X-RateLimit-Limit", String(maxRequests));
      res.setHeader("X-RateLimit-Remaining", String(remaining));
      res.setHeader("X-RateLimit-Reset", String(resetAt));

      if (count > maxRequests) {
        const retryAfter = Math.max(1, resetAt - now);
        res.setHeader("Retry-After", String(retryAfter));
        return res.status(429).json({
          message,
          retryAfter,
        });
      }
    } catch (_error) {
      return next();
    }

    return next();
  };
}
