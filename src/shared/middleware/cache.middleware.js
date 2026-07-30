import { Redis } from "@upstash/redis";
import { createHash } from "node:crypto";

let redisClient = null;
const TAG_KEY_PREFIX = "cache-tag::";
const memoryCacheStore = new Map();
const memoryTagStore = new Map();

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

function getMemoryEntry(key) {
  const entry = memoryCacheStore.get(key);
  if (!entry) return null;

  if (entry.expiresAt <= Date.now()) {
    memoryCacheStore.delete(key);
    return null;
  }

  return entry.value;
}

function setMemoryEntry(key, value, ttlSeconds) {
  const ttlMs = Math.max(Number(ttlSeconds || 0), 1) * 1000;
  memoryCacheStore.set(key, {
    value,
    expiresAt: Date.now() + ttlMs,
  });
}

function indexMemoryKeyByTags(cacheKey, tags = []) {
  for (const tag of normalizeTags(tags)) {
    if (!memoryTagStore.has(tag)) {
      memoryTagStore.set(tag, new Set());
    }
    memoryTagStore.get(tag).add(cacheKey);
  }
}

function invalidateMemoryByTags(tags = []) {
  for (const tag of normalizeTags(tags)) {
    const keys = memoryTagStore.get(tag);
    if (!keys || !keys.size) continue;

    for (const key of keys) {
      memoryCacheStore.delete(key);
    }

    memoryTagStore.delete(tag);
  }
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

function logCacheRedisError(action, error) {
  const message = error?.message || error;
  console.error(`[cache] Redis ${action} failed:`, message);
}

function normalizeCachedEntry(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return raw;

  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (_error) {
      return null;
    }
  }

  return null;
}

function normalizeRoutePath(req) {
  const raw = `${String(req.baseUrl || "")}${String(req.path || "")}` || "/";
  if (raw.length > 1 && raw.endsWith("/")) {
    return raw.slice(0, -1);
  }
  return raw || "/";
}

function resolveUserCacheScope(req, varyByUser) {
  if (!varyByUser) return "public";
  if (req.user?.id) return `user:${req.user.id}`;

  const authHeader = String(req.headers?.authorization || "").trim();
  if (authHeader) {
    const fingerprint = createHash("sha256")
      .update(authHeader)
      .digest("hex")
      .slice(0, 16);
    return `auth:${fingerprint}`;
  }

  return "guest";
}

export async function invalidateCacheByTags(tags = []) {
  const redis = getRedisClient();
  const normalizedTags = normalizeTags(tags);
  if (!normalizedTags.length) return;

  invalidateMemoryByTags(normalizedTags);
  if (!redis) return;

  for (const tag of normalizedTags) {
    const tagKey = getTagKey(tag);
    const keys = await redis.smembers(tagKey).catch((error) => {
      logCacheRedisError(`smembers(${tagKey})`, error);
      return [];
    });
    if (Array.isArray(keys) && keys.length) {
      await redis.del(...keys).catch((error) => {
        logCacheRedisError(`del(keys:${keys.length})`, error);
      });
    }
    await redis.del(tagKey).catch((error) => {
      logCacheRedisError(`del(${tagKey})`, error);
    });
  }
}

export function cacheGetResponse(options = {}) {
  const {
    prefix = "api-cache",
    ttlSeconds = 10000,
    varyByUser = false,
    tags = [],
  } = options;

  return async function cacheMiddleware(req, res, next) {
    const redis = getRedisClient();
    const cacheControl = String(
      req.headers?.["cache-control"] || "",
    ).toLowerCase();
    const shouldBypassCache =
      String(req.query?.nocache || "") === "true" ||
      cacheControl.includes("no-cache");

    // if (req.method !== "GET") {
    //   return next();
    // }

    // if (shouldBypassCache) {
    //   return next();
    // }

    const queryPart = serializeQuery(req.query);
    const userPart = resolveUserCacheScope(req, varyByUser);
    const routePath = normalizeRoutePath(req);
    const key = `${prefix}:${userPart}:${routePath}${queryPart ? `?${queryPart}` : ""}`;
    const resolvedTags = normalizeTags(
      typeof tags === "function" ? tags(req) : tags,
    );

    try {
      console.log("Try here");
      let cachedRaw = null;
      if (redis) {
        try {
          cachedRaw = await redis.get(key);
          console.log("Try here", cachedRaw);
        } catch (error) {
          logCacheRedisError(`get(${key})`, error);
          cachedRaw = null;
        }
      }
      if (!cachedRaw) {
        cachedRaw = getMemoryEntry(key);
      }

      const cached = normalizeCachedEntry(cachedRaw);
      if (cached) {
        res.setHeader("X-CACHE", "HIT");
        return res.status(Number(cached.statusCode || 200)).json(
          enrichResponsePayload(cached.payload, {
            isCached: true,
            lastCached: cached.cachedAt || null,
          }),
        );
      }
    } catch (_error) {}

    if (!res.headersSent && !res.getHeader("X-CACHE")) {
      res.setHeader("X-CACHE", "MISS");
    }

    const originalJson = res.json.bind(res);
    res.json = (payload) => {
      const cachedAt = new Date().toISOString();
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const cachePayload = {
          statusCode: res.statusCode,
          payload,
          cachedAt,
        };

        setMemoryEntry(key, cachePayload, ttlSeconds);
        indexMemoryKeyByTags(key, resolvedTags);

        if (redis) {
          redis
            .set(key, cachePayload, { ex: ttlSeconds })
            .then(() => indexCacheKeyByTags(redis, key, resolvedTags))
            .catch((error) => {
              logCacheRedisError(`set(${key})`, error);
            });
        }
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

  if (path.startsWith("/api/tags")) {
    push("tags", "courses");
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
    push(
      "progress",
      "courses",
      "enrollments",
      "notifications",
      "certifications",
    );
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
