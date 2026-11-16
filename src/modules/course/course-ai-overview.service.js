import axios from "axios";
import { prisma } from "../../shared/database/prisma.js";
import { env } from "../../shared/config/env.js";
import { listCourses } from "./course.service.js";

const CACHE_TTL_MS = 15 * 60 * 1000;
const CACHE_MAX_ENTRIES = 200;
const STOP_WORDS = new Set([
  "a", "an", "and", "the", "for", "to", "of", "in", "on", "with", "how", "what",
  "learn", "course", "courses", "best", "me", "my", "i", "is", "are", "can", "about",
]);

const cache = new Map();

function readJson(content) {
  const raw = String(content || "").trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  try {
    return JSON.parse(candidate);
  } catch (_error) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch (_nested) {
      return null;
    }
  }
}

function extractKeywords(search) {
  const words = String(search || "")
    .toLowerCase()
    .replace(/[^a-z0-9+#.\s-]/g, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 2 && !STOP_WORDS.has(word));
  return [...new Set(words)].slice(0, 6);
}

async function findCandidateCourses(search, user) {
  const keywords = extractKeywords(search);
  const terms = keywords.length ? keywords : [String(search || "").toLowerCase()];

  const rows = await prisma.course.findMany({
    where: {
      deletedAt: null,
      isPublished: true,
      workflowStatus: "PUBLISHED",
      OR: terms.flatMap((term) => [
        { title: { contains: term, mode: "insensitive" } },
        { subtitle: { contains: term, mode: "insensitive" } },
        { category: { name: { contains: term, mode: "insensitive" } } },
        { lessons: { some: { topic: { name: { contains: term, mode: "insensitive" } } } } },
      ]),
    },
    orderBy: [{ enrollments: { _count: "desc" } }, { createdAt: "desc" }],
    take: 12,
    select: { id: true },
  });
  if (!rows.length) return [];

  const ids = rows.map((row) => row.id);
  const result = await listCourses({ ids, limit: ids.length, page: 1 }, user);
  const order = new Map(ids.map((id, index) => [id, index]));
  return [...result.data].sort((a, b) => order.get(a.id) - order.get(b.id));
}

async function askModel(search, candidates) {
  const systemPrompt =
    "You are the search assistant of an online course marketplace. " +
    "Given a learner's search and a list of candidate courses, pick the best courses and write a short overview. " +
    "Return ONLY valid JSON with no markdown fences. " +
    'Schema: {"summary": string, "picks": [{"id": string, "reason": string}]}. ' +
    "summary: 1-2 plain-text sentences (max 45 words) explaining how to approach learning this topic, based only on the candidates. " +
    "picks: 1 to 3 items, ordered best first, each id MUST be copied from the candidates. " +
    "reason: one plain-text sentence (max 20 words) on why the course fits the search. " +
    "Never invent courses, prices, durations or facts that are not in the candidates.";

  const response = await axios.post(
    `${env.deepseekBaseUrl.replace(/\/+$/g, "")}/chat/completions`,
    {
      model: env.deepseekModel,
      temperature: 0.3,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: JSON.stringify({
            search,
            candidates: candidates.map((course) => ({
              id: course.id,
              title: course.title,
              subtitle: course.subtitle || null,
              category: course.category?.name || null,
              level: course.level?.title || null,
              rating: course.stats?.average_rating || 0,
              ratings_count: course.stats?.total_reviews || 0,
              lectures: course.stats?.total_lectures || 0,
            })),
          }),
        },
      ],
    },
    {
      headers: { Authorization: `Bearer ${env.aiKey}`, "Content-Type": "application/json" },
      timeout: 25000,
    },
  );

  return readJson(response?.data?.choices?.[0]?.message?.content);
}

export async function getSearchAiOverview(rawSearch, user = null) {
  const search = String(rawSearch || "").trim().slice(0, 120);
  if (search.length < 2) return null;

  const cacheKey = search.toLowerCase();
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) {
    // Course card data (cart/enrolled flags) is per user, so only the AI text is cached.
    return hit.value ? rebuild(hit.value, user) : null;
  }

  const candidates = await findCandidateCourses(search, user);
  if (!candidates.length) {
    cache.set(cacheKey, { value: null, expiresAt: Date.now() + CACHE_TTL_MS });
    return null;
  }

  let summary = "";
  let picks = [];
  let ai = false;

  if (env.aiKey) {
    try {
      const parsed = await askModel(search, candidates);
      const byId = new Map(candidates.map((course) => [course.id, course]));
      picks = (Array.isArray(parsed?.picks) ? parsed.picks : [])
        .filter((pick) => byId.has(pick?.id))
        .slice(0, 3)
        .map((pick) => ({ id: pick.id, reason: String(pick.reason || "").slice(0, 240) }));
      summary = String(parsed?.summary || "").trim().slice(0, 500);
      ai = Boolean(summary && picks.length);
    } catch (_error) {
      ai = false;
    }
  }

  if (!ai) {
    summary = "";
    picks = candidates.slice(0, 3).map((course) => ({ id: course.id, reason: "" }));
  }

  const value = { search, summary, ai, picks };
  if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(cacheKey, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return rebuild(value, user, candidates);
}

async function rebuild(value, user, knownCourses = null) {
  const ids = value.picks.map((pick) => pick.id);
  let courses = knownCourses?.filter((course) => ids.includes(course.id));
  if (!courses || courses.length !== ids.length) {
    const result = await listCourses({ ids, limit: ids.length, page: 1 }, user);
    courses = result.data;
  }
  const byId = new Map(courses.map((course) => [course.id, course]));
  return {
    search: value.search,
    summary: value.summary,
    ai: value.ai,
    picks: value.picks
      .filter((pick) => byId.has(pick.id))
      .map((pick) => ({ course: byId.get(pick.id), reason: pick.reason })),
  };
}
