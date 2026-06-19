import { Redis } from "@upstash/redis";

let redisClient = null;
const TAG_KEY_PREFIX = "cache-tag::";

function getRedisClient() {
  if (redisClient) return redisClient;

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    return null;
  }

  redisClient = new Redis({ url, token });
  return redisClient;
}

function serializeQuery(query = {}) {
  const keys = Object.keys(query || {}).sort();
  if (!keys.length) return "";

  const pairs = [];
  for (const key of keys) {
    const value = query[key];
    if (value === undefined || value === null || value === "") continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        pairs.push(`${key}=${String(item)}`);
      }
    } else {
      pairs.push(`${key}=${String(value)}`);
    }
  }
  return pairs.join("&");
}

function enrichResponsePayload(payload, { isCached, lastCached }) {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return {
      ...payload,
      isCached,
      lastCached,
    };
  }

  return {
    data: payload,
    isCached,
    lastCached,
  };
}

function normalizeTags(tagsInput = []) {
  return Array.from(
    new Set(
      (Array.isArray(tagsInput) ? tagsInput : [])
        .map((tag) => String(tag || "").trim())
        .filter(Boolean),
    ),
  );
}

function getTagKey(tag) {
  return `${TAG_KEY_PREFIX}${tag}`;
}

async function indexCacheKeyByTags(redis, cacheKey, tags = []) {
  const normalizedTags = normalizeTags(tags);
  if (!normalizedTags.length) return;

  await Promise.all(
    normalizedTags.map((tag) => redis.sadd(getTagKey(tag), cacheKey)),
  );
}

export async function invalidateCacheByTags(tags = []) {
  const redis = getRedisClient();
  if (!redis) return;

  const normalizedTags = normalizeTags(tags);
  if (!normalizedTags.length) return;

  for (const tag of normalizedTags) {
    const tagKey = getTagKey(tag);
    const keys = await redis.smembers(tagKey).catch(() => []);
    if (Array.isArray(keys) && keys.length) {
      await redis.del(...keys).catch(() => {});
    }
    await redis.del(tagKey).catch(() => {});
  }
}

export function cacheGetResponse(options = {}) {
  const {
    prefix = "api-cache",
    ttlSeconds = 60,
    varyByUser = false,
    tags = [],
  } = options;

  return async function cacheMiddleware(req, res, next) {
    const redis = getRedisClient();
    if (!redis || req.method !== "GET") {
      return next();
    }

    const queryPart = serializeQuery(req.query);
    const userPart = varyByUser ? `user:${req.user?.id || "guest"}` : "public";
    const key = `${prefix}:${userPart}:${req.path}${queryPart ? `?${queryPart}` : ""}`;
    const resolvedTags = normalizeTags(
      typeof tags === "function" ? tags(req) : tags,
    );

    try {
      const cached = await redis.get(key);
      if (cached && typeof cached === "object") {
        return res
          .status(Number(cached.statusCode || 200))
          .json(
            enrichResponsePayload(cached.payload, {
              isCached: true,
              lastCached: cached.cachedAt || null,
            }),
          );
      }
    } catch (_error) {}

    const originalJson = res.json.bind(res);
    res.json = (payload) => {
      const cachedAt = new Date().toISOString();
      if (res.statusCode >= 200 && res.statusCode < 300) {
        redis
          .set(
            key,
            {
              statusCode: res.statusCode,
              payload,
              cachedAt,
            },
            { ex: ttlSeconds },
          )
          .then(() => indexCacheKeyByTags(redis, key, resolvedTags))
          .catch(() => {});
      }

      return originalJson(
        enrichResponsePayload(payload, {
          isCached: false,
          lastCached: cachedAt,
        }),
      );
    };

    return next();
  };
}

function getInvalidationTagsFromRequest(req) {
  const method = String(req.method || "").toUpperCase();
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return [];

  const path = String(req.path || req.originalUrl || "");
  const tags = [];

  const push = (...items) => {
    for (const item of items) {
      const tag = String(item || "").trim();
      if (tag) tags.push(tag);
    }
  };

  if (path.startsWith("/api/courses") || path.startsWith("/api/curriculum")) {
    push("courses", "reviews", "enrollments", "progress", "certifications");
  }

  if (path.startsWith("/api/categories")) {
    push("categories", "courses");
  }

  if (path.startsWith("/api/reviews")) {
    push("reviews", "courses");
    const courseId = req.params?.courseId || req.body?.courseId || "";
    if (courseId) {
      push(`reviews:course:${courseId}`);
    }
  }

  if (path.startsWith("/api/analytics")) {
    push("activity", "courses", "admin-revenue");
  }

  if (path === "/api/users/me" && ["PUT", "PATCH"].includes(method)) {
    push("courses", "users", "user-profile");
  }

  if (path.startsWith("/api/users")) {
    push("users", "user-profile");
  }

  if (path.startsWith("/api/cart")) {
    push("cart", "courses");
  }

  if (path.startsWith("/api/wishlist")) {
    push("wishlist", "courses");
  }

  if (path.startsWith("/api/progress")) {
    push("progress", "courses", "enrollments", "notifications", "certifications");
  }

  if (path.startsWith("/api/notifications")) {
    push("notifications");
  }

  if (path.startsWith("/api/checkout")) {
    push(
      "orders",
      "enrollments",
      "cart",
      "wishlist",
      "courses",
      "notifications",
      "certifications",
      "payouts",
      "admin-revenue",
    );
  }

  if (path.startsWith("/api/payouts")) {
    push("payouts", "notifications", "admin-revenue");
  }

  if (path.startsWith("/api/certifications")) {
    push("certifications");
  }

  if (path.startsWith("/api/admin/courses")) {
    push("courses", "notifications", "admin-courses");
  }

  if (path.startsWith("/api/admin/reports")) {
    push("admin-revenue", "orders", "payouts");
  }

  if (path.startsWith("/api/")) {
    push("legacy");
  }

  return normalizeTags(tags);
}

export function cacheInvalidationOnMutation() {
  return function cacheInvalidationMiddleware(req, res, next) {
    const tags = getInvalidationTagsFromRequest(req);
    if (!tags.length) return next();

    const originalJson = res.json.bind(res);
    res.json = (payload) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        invalidateCacheByTags(tags).catch(() => {});
      }
      return originalJson(payload);
    };

    return next();
  };
}
