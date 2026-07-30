import { prisma } from "../../shared/database/prisma.js";
import { Prisma } from "@prisma/client";
import axios from "axios";
import { ApiError } from "../../shared/utils/ApiError.js";
import { getPagination, toPagedResult } from "../../shared/utils/pagination.js";
import { slugify } from "../../shared/utils/slugify.js";
import { recordActivityEvent } from "../analytics/analytics.service.js";
import { env } from "../../shared/config/env.js";

const COVER_MEDIA_TYPES = ["IMAGE", "COVER_IMAGE"];
const PROMO_MEDIA_TYPES = ["PROMO_VIDEO"];
const COURSE_GOALS_KEY_PREFIX = "course_goals::";

function pickLatestMediaByTypes(mediaList = [], types = []) {
  return mediaList.find((item) => types.includes(item.mediaType)) || null;
}

function mapLegacyMedia(media) {
  if (!media) return null;
  return {
    id: media.id,
    path: media.storagePath,
    title: media.originalName,
  };
}

async function getLatestUserPicturesMap(userIds = []) {
  const uniqueUserIds = Array.from(new Set((userIds || []).filter(Boolean)));
  if (!uniqueUserIds.length) return new Map();

  const mediaRows = await prisma.media.findMany({
    where: {
      userId: { in: uniqueUserIds },
      courseId: null,
      mediaType: "IMAGE",
    },
    select: {
      id: true,
      userId: true,
      storagePath: true,
      originalName: true,
    },
    orderBy: { createdAt: "desc" },
  });

  const map = new Map();
  for (const row of mediaRows) {
    if (!map.has(row.userId)) {
      map.set(row.userId, {
        id: row.id,
        path: row.storagePath,
        title: row.originalName || "",
      });
    }
  }

  return map;
}

function getCourseGoalsSettingKey(courseId) {
  return `${COURSE_GOALS_KEY_PREFIX}${courseId}`;
}

function normalizeGoalsPayload(payload = {}) {
  const toList = (input) =>
    Array.isArray(input)
      ? input
          .map((item) => String(item ?? "").trim())
          .filter(Boolean)
      : [];

  return {
    what_you_will_learn_data: toList(payload.what_you_will_learn_data),
    requirements_data: toList(payload.requirements_data),
    who_should_attend_data: toList(payload.who_should_attend_data),
  };
}

async function readCourseGoals(courseId) {
  const setting = await prisma.platformSetting.findUnique({
    where: { key: getCourseGoalsSettingKey(courseId) },
    select: { value: true },
  });

  if (!setting?.value) {
    return normalizeGoalsPayload({});
  }

  try {
    const parsed = JSON.parse(setting.value);
    return normalizeGoalsPayload(parsed);
  } catch (_error) {
    throw new ApiError(500, "Stored course goals are invalid");
  }
}

async function readCourseGoalsMap(courseIds = []) {
  const uniqueIds = Array.from(new Set((courseIds || []).filter(Boolean)));
  if (!uniqueIds.length) return new Map();

  const keys = uniqueIds.map((courseId) => getCourseGoalsSettingKey(courseId));
  const settings = await prisma.platformSetting.findMany({
    where: { key: { in: keys } },
    select: { key: true, value: true },
  });

  const settingMap = new Map(settings.map((setting) => [setting.key, setting.value]));
  const goalsMap = new Map();

  for (const courseId of uniqueIds) {
    const key = getCourseGoalsSettingKey(courseId);
    const rawValue = settingMap.get(key);
    if (!rawValue) {
      goalsMap.set(courseId, normalizeGoalsPayload({}));
      continue;
    }

    try {
      const parsed = JSON.parse(rawValue);
      goalsMap.set(courseId, normalizeGoalsPayload(parsed));
    } catch (_error) {
      goalsMap.set(courseId, normalizeGoalsPayload({}));
    }
  }

  return goalsMap;
}

function extractMediaId(value) {
  if (!value) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "object" && value.id) return String(value.id).trim();
  return "";
}

function safeParseJson(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
}

function normalizeVisibleCodingTests(codingPayload) {
  const testCasesByLanguage = codingPayload?.test_cases;
  if (!testCasesByLanguage || typeof testCasesByLanguage !== "object") {
    return {};
  }

  const output = {};
  for (const [language, items] of Object.entries(testCasesByLanguage)) {
    const normalized = Array.isArray(items)
      ? items
          .map((item, index) => ({
            id: String(item?.id || `${language}-tc-${index + 1}`),
            name: String(item?.name || `Test #${index + 1}`),
            input: String(item?.input || ""),
            expected_output: String(
              item?.expected_output !== undefined ? item.expected_output : item?.expectedOutput || "",
            ),
            comparison_mode: String(item?.comparison_mode || item?.comparisonMode || "EXACT").toUpperCase(),
            visibility: String(item?.visibility || "VISIBLE").toUpperCase(),
          }))
          .filter((item) => item.visibility !== "HIDDEN")
      : [];
    output[language] = normalized;
  }
  return output;
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

const ARTICLE_WORDS_PER_MINUTE = 220;
const QUIZ_BASE_SECONDS = 30;
const QUIZ_SECONDS_PER_QUESTION = 75;
const CODING_WORDS_PER_MINUTE = 180;
const CODING_BASE_SECONDS = 180;
const CODING_SECONDS_PER_CODE_LINE = 20;

function stripHtml(value = "") {
  return String(value || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function countWords(value = "") {
  const text = stripHtml(value);
  if (!text) return 0;
  return text.split(" ").filter(Boolean).length;
}

function estimateReadingSecondsByWords(words, wordsPerMinute, minimumSeconds = 0) {
  if (!words || words <= 0 || wordsPerMinute <= 0) return minimumSeconds;
  const computedSeconds = Math.ceil((words / wordsPerMinute) * 60);
  return Math.max(minimumSeconds, computedSeconds);
}

function normalizeQuizQuestions(input) {
  const parsed = safeParseJson(input);
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.questions)) return parsed.questions;
  return [];
}

function countStarterCodeLines(input) {
  const parsed = safeParseJson(input);
  if (!parsed) return 0;
  if (typeof parsed === "string") {
    return parsed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length;
  }

  const starterCode = parsed?.starter_code;
  if (!starterCode) return 0;
  if (typeof starterCode === "string") {
    return starterCode.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).length;
  }
  if (typeof starterCode === "object") {
    return Object.values(starterCode).reduce((sum, codeByLanguage) => {
      const lineCount = String(codeByLanguage || "")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean).length;
      return sum + lineCount;
    }, 0);
  }

  return 0;
}

function estimateLessonDurationSeconds(lesson) {
  const explicitDuration = Number(lesson?.durationInSeconds || 0);
  if (explicitDuration > 0) return explicitDuration;

  const lessonType = String(lesson?.type || "").toUpperCase();

  if (lessonType === "RESOURCE" || lessonType === "ASSIGNMENT") {
    const articleWords = countWords(lesson?.assignmentText || lesson?.description || "");
    return estimateReadingSecondsByWords(articleWords, ARTICLE_WORDS_PER_MINUTE, 60);
  }

  if (lessonType === "QUIZ") {
    const questions = normalizeQuizQuestions(lesson?.quizQuestions);
    if (!questions.length) return 60;
    return QUIZ_BASE_SECONDS + questions.length * QUIZ_SECONDS_PER_QUESTION;
  }

  if (lessonType === "CODING_EXERCISE") {
    const instructionWords = countWords(
      `${lesson?.codingInstructions || ""} ${lesson?.description || ""}`,
    );
    const readingSeconds = estimateReadingSecondsByWords(
      instructionWords,
      CODING_WORDS_PER_MINUTE,
      90,
    );
    const starterCodeLines = countStarterCodeLines(lesson?.codingStarterCode);
    const implementationSeconds = starterCodeLines * CODING_SECONDS_PER_CODE_LINE;
    return Math.max(300, CODING_BASE_SECONDS + readingSeconds + implementationSeconds);
  }

  return 0;
}

function getCourseInclude() {
  return {
    educator: {
      select: { id: true, username: true, firstName: true, lastName: true, headline: true },
    },
    level: true,
    priceTier: true,
    sections: {
      include: {
        lessons: {
          select: { id: true, type: true },
        },
      },
    },
    media: {
      where: {
        mediaType: { in: [...COVER_MEDIA_TYPES, ...PROMO_MEDIA_TYPES] },
      },
      orderBy: { createdAt: "desc" },
    },
  };
}

function normalizeLevelTitle(value) {
  return String(value || "")
    .trim()
    .toLowerCase();
}

function toCourseSearchText(course) {
  return `${course?.title || ""} ${course?.subtitle || ""}`.trim();
}

function toTrimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function toQueryList(value) {
  if (Array.isArray(value)) {
    return value
      .flatMap((item) => String(item || "").split(","))
      .map((item) => item.trim())
      .filter(Boolean);
  }

  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function createScoredCourseRow(course, metrics = {}) {
  const enrollments = Number(metrics.enrollments || 0);
  const reviews = Number(metrics.reviews || 0);
  const wishlists = Number(metrics.wishlists || 0);
  const cartItems = Number(metrics.cartItems || 0);
  const pageViews = Number(metrics.pageViews || 0);
  const impressions = Number(metrics.impressions || 0);

  const score =
    enrollments * 8 +
    reviews * 4 +
    wishlists * 2 +
    cartItems * 1.5 +
    pageViews * 0.5 +
    impressions * 0.2;

  return {
    ...course,
    trendScore: Number(score.toFixed(2)),
    metrics: {
      enrollments,
      reviews,
      wishlists,
      cartItems,
      pageViews,
      impressions,
    },
  };
}

function mapDiscoveryCourseItem(course) {
  return {
    id: course.id,
    slug: course.slug,
    title: course.title,
    subtitle: course.subtitle || "",
    trend_score: course.trendScore || 0,
    category: course.category
      ? {
          id: course.category.id,
          title: course.category.name,
          slug: course.category.slug,
        }
      : null,
    educator: course.educator
      ? {
          id: course.educator.id,
          username: course.educator.username,
          first_name: course.educator.firstName || "",
          last_name: course.educator.lastName || "",
        }
      : null,
    cover_image: mapLegacyMedia(
      pickLatestMediaByTypes(course.media, ["COVER_IMAGE", "IMAGE"]),
    ),
  };
}

async function resolveLevelId(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return null;
  }

  const value = String(rawValue).trim();
  if (!value || value === "0" || value === "4") {
    return null;
  }

  const byId = await prisma.courseLevel.findUnique({
    where: { id: value },
    select: { id: true },
  });
  if (byId) return byId.id;

  const numericValue = Number(value);
  if (Number.isInteger(numericValue) && numericValue > 0) {
    const byWeight = await prisma.courseLevel.findFirst({
      where: { weight: numericValue },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (byWeight) return byWeight.id;
  }

  const title = normalizeLevelTitle(value);
  if (title === "all levels" || title === "all") {
    return null;
  }

  if (title) {
    const byTitle = await prisma.courseLevel.findFirst({
      where: { title: { equals: value, mode: "insensitive" } },
      select: { id: true },
    });
    if (byTitle) return byTitle.id;
  }

  return null;
}

async function resolveCategoryId(payload) {
  const directCategoryId = payload.categoryId || payload.category_id || null;
  if (directCategoryId) return String(directCategoryId);

  const normalizeCategoryRef = (value) => {
    if (value === undefined || value === null) return "";
    if (typeof value === "string" || typeof value === "number") {
      return String(value).trim();
    }
    if (typeof value === "object") {
      return String(value.id || value.category_id || "").trim();
    }
    return "";
  };

  const categoryIds = Array.isArray(payload.category_ids)
    ? payload.category_ids
        .map(normalizeCategoryRef)
        .filter(Boolean)
    : [];

  if (categoryIds.length === 0) return null;

  const categories = await prisma.category.findMany({
    where: {
      id: { in: categoryIds },
      deletedAt: null,
    },
    select: { id: true, parentId: true },
  });

  if (!categories.length) return null;

  // Prefer the most specific (child) category when parent + child are both submitted.
  const child = categories.find((category) => category.parentId);
  return child?.id || categories[0].id;
}

async function normalizeCoursePayload(payload) {
  const categoryId = await resolveCategoryId(payload);
  const levelInput = payload.levelId || payload.instructional_level || null;
  const levelId = await resolveLevelId(levelInput);
  const normalizeOptionalMessage = (value) => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    const normalized = String(value).trim();
    return normalized.length ? normalized : null;
  };

  const normalizedSlugInput =
    payload.slug === undefined
      ? undefined
      : slugify(String(payload.slug || ""))
          .slice(0, 150)
          .replace(/-+$/g, "");

  return {
    title: payload.title,
    slug: normalizedSlugInput,
    subtitle: payload.subtitle,
    description: payload.description,
    language:
      payload.language === undefined
        ? undefined
        : toTrimmedString(payload.language) || null,
    welcomeMessage: normalizeOptionalMessage(
      payload.welcomeMessage ?? payload.welcome_message,
    ),
    congratulationsMessage: normalizeOptionalMessage(
      payload.congratulationsMessage ?? payload.congratulations_message,
    ),
    categoryId,
    levelId,
    priceTierId: payload.priceTierId || payload.price_tier || null,
    isPublished:
      payload.published === undefined
        ? undefined
        : payload.published === true || payload.published === "1",
  };
}

async function makeUniqueSlug(title) {
  const base = slugify(String(title || ""))
    .slice(0, 150)
    .replace(/-+$/g, "");
  if (!base) {
    throw new ApiError(400, "Slug is required");
  }

  const withSuffix = (rawBase, suffix) => {
    const safeSuffix = String(suffix || "").trim();
    if (!safeSuffix) return rawBase;
    const suffixChunk = `-${safeSuffix}`;
    const maxBaseLength = Math.max(1, 150 - suffixChunk.length);
    const trimmedBase = rawBase.slice(0, maxBaseLength).replace(/-+$/g, "");
    return `${trimmedBase}${suffixChunk}`;
  };

  let attempt = 0;
  let candidate = base;

  while (attempt < 500) {
    const existing = await prisma.course.findFirst({
      where: { slug: candidate, deletedAt: null },
      select: { id: true },
    });
    if (!existing) {
      return candidate;
    }
    attempt += 1;
    candidate = withSuffix(base, attempt + 1);
  }

  throw new ApiError(409, "Unable to generate a unique slug");
}

async function assertCourseSlugAvailable(slug, excludeCourseId = null) {
  if (!slug) {
    throw new ApiError(400, "Slug is required");
  }

  const existing = await prisma.course.findFirst({
    where: {
      slug,
      deletedAt: null,
      id: excludeCourseId ? { not: excludeCourseId } : undefined,
    },
    select: { id: true },
  });

  if (existing) {
    throw new ApiError(409, "Slug already exists");
  }
}

export async function createCourse(userId, payload) {
  const normalized = await normalizeCoursePayload(payload);
  const slug = normalized.slug || (await makeUniqueSlug(payload.title));
  await assertCourseSlugAvailable(slug);

  let course;
  try {
    course = await prisma.course.create({
      data: {
        title: normalized.title,
        subtitle: normalized.subtitle,
        description: normalized.description,
        slug,
        language: normalized.language || "en",
        categoryId: normalized.categoryId,
        levelId: normalized.levelId,
        priceTierId: normalized.priceTierId,
        educatorId: userId,
        isPublished: normalized.isPublished,
      },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new ApiError(409, "Slug already exists");
    }
    throw error;
  }

  await recordActivityEvent({
    eventType: "INSTRUCTOR_COURSE_CREATED",
    userId,
    courseId: course.id,
    pagePath: "/instructor/courses",
    metadata: {
      courseTitle: course.title,
    },
  });

  return course;
}

function readJsonFromAiContent(content) {
  const raw = String(content || "").trim();
  if (!raw) return null;

  const fencedMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch ? fencedMatch[1] : raw;

  try {
    return JSON.parse(candidate);
  } catch (_error) {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const sliced = candidate.slice(start, end + 1);
      try {
        return JSON.parse(sliced);
      } catch (_nestedError) {
        return null;
      }
    }
    return null;
  }
}

function normalizeAIDraftLessonType(input) {
  const raw = String(input || "RESOURCE")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");

  if (raw === "ARTICLE") return "RESOURCE";
  if (["VIDEO", "QUIZ", "CODING_EXERCISE", "RESOURCE", "ASSIGNMENT"].includes(raw)) {
    return raw;
  }
  return "RESOURCE";
}

function looksLikeGenericSectionTitle(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return true;
  return /^section\s*\d+/.test(normalized) || /^module\s*\d+/.test(normalized);
}

function looksLikeGenericLessonTitle(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return true;
  return (
    /^lesson\s*[\d.]+/.test(normalized) ||
    /^lecture\s*[\d.]+/.test(normalized) ||
    /^curriculum\s*[\d.]+/.test(normalized) ||
    normalized === "ai-generated lesson"
  );
}

function buildAIDraftFocusTerms(sourceText = "") {
  const stop = new Set([
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "into",
    "your",
    "you",
    "are",
    "what",
    "when",
    "where",
    "which",
    "have",
    "has",
    "had",
    "how",
    "why",
    "all",
    "about",
    "course",
    "lesson",
    "section",
    "curriculum",
  ]);
  const words = String(sourceText || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 4 && !stop.has(word));

  const unique = [];
  const seen = new Set();
  for (const word of words) {
    if (seen.has(word)) continue;
    seen.add(word);
    unique.push(word);
    if (unique.length >= 8) break;
  }
  return unique;
}

function toTitleCase(value = "") {
  return String(value || "")
    .split(" ")
    .filter(Boolean)
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join(" ");
}

function suggestSectionTitleFromTerms(index, terms = [], fallbackTitle = "Course") {
  const templates = [
    "Foundations of {{term}}",
    "Core {{term}} Concepts",
    "Practical {{term}} Workflow",
    "{{term}} Applications",
    "Advanced {{term}} Techniques",
  ];
  const rawTerm = terms[index % Math.max(1, terms.length)] || fallbackTitle;
  const term = toTitleCase(rawTerm);
  const template = templates[index % templates.length];
  return template.replace("{{term}}", term).slice(0, 160);
}

function suggestLessonTitleFromTerms(sectionTitle, index, terms = []) {
  const rawTerm = terms[index % Math.max(1, terms.length)] || sectionTitle || "Topic";
  const term = toTitleCase(rawTerm);
  const templates = [
    `Understanding ${term}`,
    `${term} Walkthrough`,
    `${term} in Practice`,
    `${term} Troubleshooting`,
    `Hands-on ${term} Exercise`,
  ];
  return templates[index % templates.length].slice(0, 180);
}

function ensureUniqueTitle(rawTitle, usedSet, maxLength = 180, fallback = "Untitled Topic") {
  const base = trimForDb(rawTitle, maxLength) || fallback;
  let candidate = base;
  let suffix = 2;

  while (usedSet.has(candidate.toLowerCase())) {
    const suffixText = ` (${suffix})`;
    const trimmedBase = trimForDb(base, Math.max(1, maxLength - suffixText.length));
    candidate = `${trimmedBase}${suffixText}`;
    suffix += 1;
  }

  usedSet.add(candidate.toLowerCase());
  return candidate;
}

function resolveSectionObjectiveText(rawDescription, sectionTitle, courseTitle) {
  const normalized = trimForDb(rawDescription, 5000);
  if (normalized) return normalized;
  const safeSectionTitle = trimForDb(sectionTitle, 160) || "this section";
  const safeCourseTitle = trimForDb(courseTitle, 120) || "the course";
  return `Learning objective: Build practical understanding of ${safeSectionTitle} and how it connects to ${safeCourseTitle}.`;
}

function resolveCurriculumDescriptionText(
  rawDescription,
  lessonTitle,
  sectionTitle,
  courseTitle,
) {
  const normalized = trimForDb(rawDescription, 8000);
  if (normalized) return normalized;
  const safeLessonTitle = trimForDb(lessonTitle, 180) || "this lesson";
  const safeSectionTitle = trimForDb(sectionTitle, 160) || "this section";
  const safeCourseTitle = trimForDb(courseTitle, 120) || "the course";
  return `In this lesson, you'll learn ${safeLessonTitle} within ${safeSectionTitle}, with practical examples aligned to ${safeCourseTitle}.`;
}

async function loadAICourseTopicCatalog(courseCategoryId) {
  const normalizedCategoryId = String(courseCategoryId || "").trim();
  if (!normalizedCategoryId) return [];

  const categories = await prisma.category.findMany({
    where: {
      deletedAt: null,
      OR: [
        { id: normalizedCategoryId },
        { parentId: normalizedCategoryId },
        {
          parent: {
            id: normalizedCategoryId,
          },
        },
      ],
    },
    select: { id: true },
  });

  const categoryIds = Array.from(
    new Set([
      normalizedCategoryId,
      ...categories.map((row) => String(row.id || "").trim()).filter(Boolean),
    ]),
  );

  const topics = await prisma.topic.findMany({
    where: {
      deletedAt: null,
      categoryId: { in: categoryIds },
    },
    select: {
      id: true,
      name: true,
      slug: true,
      categoryId: true,
      category: {
        select: {
          id: true,
          name: true,
          slug: true,
        },
      },
    },
  });

  return topics;
}

function pickBestTopicForAIGeneratedLesson(topicCatalog = [], context = {}) {
  if (!Array.isArray(topicCatalog) || topicCatalog.length === 0) return null;

  const sourceText = [
    context?.topicHint,
    context?.title,
    context?.description,
    context?.sectionTitle,
    context?.courseTitle,
    context?.courseDescription,
  ]
    .map((value) => String(value || ""))
    .join(" ");
  const tokens = buildAIDraftFocusTerms(sourceText);
  if (!tokens.length) return null;

  let best = null;
  for (const topic of topicCatalog) {
    const haystack = buildAIDraftFocusTerms(
      `${topic?.name || ""} ${topic?.slug || ""} ${topic?.category?.name || ""} ${topic?.category?.slug || ""}`,
    );
    const haystackSet = new Set(haystack);

    let score = 0;
    for (const token of tokens) {
      if (haystackSet.has(token)) score += 8;
      if (String(topic?.name || "").toLowerCase().includes(token)) score += 5;
      if (String(topic?.slug || "").toLowerCase().includes(token)) score += 4;
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { topic, score };
    }
  }

  return best?.topic || null;
}

function normalizeAIDraftPayload(draft, fallbackPrompt) {
  const source = draft && typeof draft === "object" ? draft : {};
  const title = String(source.title || "")
    .trim()
    .slice(0, 60);
  const fallbackTitle = String(fallbackPrompt || "")
    .trim()
    .slice(0, 60);
  const safeTitle =
    title.length >= 3
      ? title
      : fallbackTitle.length >= 3
        ? fallbackTitle
        : "AI Course Draft";
  const focusTerms = buildAIDraftFocusTerms(`${safeTitle} ${fallbackPrompt || ""}`);

  const subtitle = String(source.subtitle || "")
    .trim()
    .slice(0, 180);
  const description = String(source.description || source.course_description || "")
    .trim()
    .slice(0, 8000);
  const language = String(source.language || "English")
    .trim()
    .slice(0, 100);
  const instructionalLevel = String(
    source.instructional_level || source.level || "",
  )
    .trim()
    .slice(0, 120);
  const categoryHint = String(source.category || source.category_hint || "")
    .trim()
    .slice(0, 140);
  const welcomeMessage = String(
    source.welcome_message || source.welcomeMessage || "",
  )
    .trim()
    .slice(0, 5000);
  const congratulationsMessage = String(
    source.congratulations_message || source.congratulationsMessage || "",
  )
    .trim()
    .slice(0, 5000);

  const toItems = (value) =>
    Array.isArray(value)
      ? value
          .map((item) => String(item || "").trim())
          .filter(Boolean)
          .slice(0, 20)
      : [];

  const whatYouWillLearn = toItems(
    source.what_you_will_learn || source.what_you_will_learn_data,
  );
  const requirements = toItems(source.requirements || source.requirements_data);
  const whoShouldAttend = toItems(
    source.who_should_attend || source.who_should_attend_data,
  );

  const rawSections = Array.isArray(source.sections) ? source.sections : [];
  const sections = rawSections
    .slice(0, 20)
    .map((section, sectionIndex) => {
      const sectionTitleRaw = String(section?.title || "").trim();
      const sectionTitle = (
        !sectionTitleRaw || looksLikeGenericSectionTitle(sectionTitleRaw)
          ? suggestSectionTitleFromTerms(sectionIndex, focusTerms, safeTitle)
          : sectionTitleRaw
      ).slice(0, 160);
      const sectionDescription = String(section?.description || "")
        .trim()
        .slice(0, 5000);
      const rawLessons = Array.isArray(section?.lessons)
        ? section.lessons
        : Array.isArray(section?.curriculums)
          ? section.curriculums
          : [];
      const lessons = rawLessons
        .slice(0, 50)
        .map((lesson, lessonIndex) => {
          const lessonTitleRaw = String(lesson?.title || "").trim();
          const lessonTitle = (
            !lessonTitleRaw || looksLikeGenericLessonTitle(lessonTitleRaw)
              ? suggestLessonTitleFromTerms(sectionTitle, lessonIndex, focusTerms)
              : lessonTitleRaw
          ).slice(0, 180);
          const lessonDescription = String(
            lesson?.description || lesson?.curriculum_description || "",
          )
            .trim()
            .slice(0, 8000);
          const estimatedMinutes = Number(
            lesson?.estimated_minutes || lesson?.duration_minutes || 8,
          );
          const durationInSeconds = Number.isFinite(estimatedMinutes)
            ? Math.max(60, Math.min(60 * 90, Math.round(estimatedMinutes * 60)))
            : 8 * 60;

          return {
            title: lessonTitle,
            description: resolveCurriculumDescriptionText(
              lessonDescription,
              lessonTitle,
              sectionTitle,
              safeTitle,
            ),
            type: normalizeAIDraftLessonType(
              lesson?.type || lesson?.curriculum_type || "RESOURCE",
            ),
            durationInSeconds,
          };
        })
        .filter((lesson) => lesson.title.length >= 2);

      return {
        title: sectionTitle,
        description: resolveSectionObjectiveText(
          sectionDescription,
          sectionTitle,
          safeTitle,
        ),
        lessons:
          lessons.length > 0
            ? lessons
            : [
                {
                    title: suggestLessonTitleFromTerms(sectionTitle, 0, focusTerms),
                    description: resolveCurriculumDescriptionText(
                      "",
                      suggestLessonTitleFromTerms(sectionTitle, 0, focusTerms),
                      sectionTitle,
                      safeTitle,
                    ),
                    type: "RESOURCE",
                    durationInSeconds: 8 * 60,
                },
              ],
      };
    })
    .filter((section) => section.title.length >= 2);

  const fallbackSections =
    sections.length > 0
      ? sections
      : [
          {
            title: "Introduction and course roadmap",
            description: "Set expectations and walk learners through the journey.",
            lessons: [
              {
                title: "Welcome and outcomes",
                description: "Introduce the course and key outcomes.",
                type: "RESOURCE",
                durationInSeconds: 6 * 60,
              },
            ],
          },
          {
            title: "Core concepts",
            description: "Break down foundational concepts into practical lessons.",
            lessons: [
              {
                title: "Core concept walkthrough",
                description: "Teach the most important concept with examples.",
                type: "RESOURCE",
                durationInSeconds: 10 * 60,
              },
            ],
          },
          {
            title: "Applied practice",
            description: "Help learners apply knowledge in practical scenarios.",
            lessons: [
              {
                title: "Hands-on practice",
                description: "Practice exercise to reinforce the lessons.",
                type: "ASSIGNMENT",
                durationInSeconds: 12 * 60,
              },
            ],
          },
        ];

  const paddedSections = [...fallbackSections];
  while (paddedSections.length < 3) {
    const nextIndex = paddedSections.length + 1;
    const suggestedSectionTitle = suggestSectionTitleFromTerms(
      nextIndex - 1,
      focusTerms,
      safeTitle,
    );
    paddedSections.push({
      title: suggestedSectionTitle,
      description: resolveSectionObjectiveText(
        "",
        suggestedSectionTitle,
        safeTitle,
      ),
      lessons: [
        {
          title: suggestLessonTitleFromTerms(suggestedSectionTitle, 0, focusTerms),
          description: resolveCurriculumDescriptionText(
            "",
            suggestLessonTitleFromTerms(suggestedSectionTitle, 0, focusTerms),
            suggestedSectionTitle,
            safeTitle,
          ),
          type: "RESOURCE",
          durationInSeconds: 8 * 60,
        },
        {
          title: suggestLessonTitleFromTerms(suggestedSectionTitle, 1, focusTerms),
          description: resolveCurriculumDescriptionText(
            "",
            suggestLessonTitleFromTerms(suggestedSectionTitle, 1, focusTerms),
            suggestedSectionTitle,
            safeTitle,
          ),
          type: "VIDEO",
          durationInSeconds: 10 * 60,
        },
        {
          title: suggestLessonTitleFromTerms(suggestedSectionTitle, 2, focusTerms),
          description: resolveCurriculumDescriptionText(
            "",
            suggestLessonTitleFromTerms(suggestedSectionTitle, 2, focusTerms),
            suggestedSectionTitle,
            safeTitle,
          ),
          type: "ASSIGNMENT",
          durationInSeconds: 12 * 60,
        },
      ],
    });
  }

  for (const section of paddedSections) {
    const lessons = Array.isArray(section.lessons) ? section.lessons : [];
    while (lessons.length < 3) {
      const nextLesson = lessons.length + 1;
      lessons.push({
        title: suggestLessonTitleFromTerms(section.title, nextLesson - 1, focusTerms),
        description: resolveCurriculumDescriptionText(
          "",
          suggestLessonTitleFromTerms(section.title, nextLesson - 1, focusTerms),
          section.title,
          safeTitle,
        ),
        type: "RESOURCE",
        durationInSeconds: 8 * 60,
      });
    }
    section.lessons = lessons;
  }

  const usedSectionTitles = new Set();
  for (let sectionIndex = 0; sectionIndex < paddedSections.length; sectionIndex += 1) {
    const section = paddedSections[sectionIndex];
    const sectionTerms = buildAIDraftFocusTerms(
      `${section?.description || ""} ${section?.title || ""} ${safeTitle} ${fallbackPrompt || ""}`,
    );
    const sectionCandidate =
      !section?.title || looksLikeGenericSectionTitle(section.title)
        ? suggestSectionTitleFromTerms(
            sectionIndex,
            sectionTerms.length ? sectionTerms : focusTerms,
            safeTitle,
          )
        : section.title;
    section.title = ensureUniqueTitle(
      sectionCandidate,
      usedSectionTitles,
      160,
      `Course Topic ${sectionIndex + 1}`,
    );

    const usedLessonTitles = new Set();
    const lessons = Array.isArray(section.lessons) ? section.lessons : [];
    for (let lessonIndex = 0; lessonIndex < lessons.length; lessonIndex += 1) {
      const lesson = lessons[lessonIndex];
      const lessonTerms = buildAIDraftFocusTerms(
        `${lesson?.description || ""} ${lesson?.title || ""} ${section.title} ${safeTitle}`,
      );
      const lessonCandidate =
        !lesson?.title || looksLikeGenericLessonTitle(lesson.title)
          ? suggestLessonTitleFromTerms(
              section.title,
              lessonIndex,
              lessonTerms.length ? lessonTerms : sectionTerms,
            )
          : lesson.title;
      lesson.title = ensureUniqueTitle(
        lessonCandidate,
        usedLessonTitles,
        180,
        `Applied ${section.title} Topic`,
      );
    }
  }

  return {
    title: safeTitle,
    subtitle,
    description,
    welcomeMessage,
    congratulationsMessage,
    language,
    instructionalLevel,
    categoryHint,
    whatYouWillLearn,
    requirements,
    whoShouldAttend,
    sections: paddedSections,
  };
}

async function resolveAICategoryId(categoryHint) {
  const normalizedHint = String(categoryHint || "").trim().toLowerCase();
  if (!normalizedHint) return null;

  const categories = await prisma.category.findMany({
    where: { deletedAt: null },
    select: { id: true, name: true, slug: true, parentId: true },
  });
  if (!categories.length) return null;

  const hintTokens = slugify(normalizedHint).split("-").filter(Boolean);
  let best = null;

  for (const category of categories) {
    const label = String(category.name || category.slug || "").toLowerCase();
    const slugLabel = String(category.slug || "").toLowerCase();
    const labelTokens = slugify(`${label} ${slugLabel}`).split("-").filter(Boolean);

    let score = 0;
    if (label === normalizedHint || slugLabel === slugify(normalizedHint)) score += 100;
    if (label.includes(normalizedHint) || normalizedHint.includes(label)) score += 45;
    for (const token of hintTokens) {
      if (labelTokens.includes(token)) score += 8;
    }
    if (category.parentId) score += 3;

    if (!best || score > best.score) {
      best = { id: category.id, score };
    }
  }

  if (!best || best.score <= 0) return null;
  return best.id;
}

async function generateCourseDraftViaAI(prompt, options = {}) {
  if (!env.aiKey) {
    throw new ApiError(
      500,
      "AI key is not configured. Set AI_KEY in the backend environment.",
    );
  }

  const systemPrompt =
    "You are an expert instructional designer. Return only valid JSON with no markdown fences. " +
    "Schema: { title, subtitle, description, welcome_message, congratulations_message, language, instructional_level, category, what_you_will_learn[], requirements[], who_should_attend[], sections:[{ title, description, lessons:[{ title, description, type, estimated_minutes }] }] }. " +
    "Constraints: title <= 60 chars, subtitle <= 180 chars, 4-8 sections, 3-8 lessons each section, lesson type one of VIDEO|RESOURCE|ASSIGNMENT|QUIZ|CODING_EXERCISE, estimated_minutes is number. " +
    "Section and lesson titles must be descriptive and specific; never use generic placeholders like 'Section 1' or 'Lesson 1'.";

  let response;
  try {
    response = await axios.post(
      `${env.deepseekBaseUrl.replace(/\/+$/g, "")}/chat/completions`,
      {
        model: env.deepseekModel,
        temperature: 0.7,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "user",
            content: `Create a complete draft course from this brief:\n${prompt}\n\nPreferred language: ${options.language || "English"}\nPreferred level: ${options.instructionalLevel || "Choose the best fit"}`,
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${env.aiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 60000,
      },
    );
  } catch (_error) {
    throw new ApiError(
      502,
      "AI provider is unavailable right now. Please try again.",
    );
  }

  const aiContent = response?.data?.choices?.[0]?.message?.content || "";
  const parsed = readJsonFromAiContent(aiContent);
  if (!parsed) {
    throw new ApiError(502, "AI returned an invalid response format");
  }
  return normalizeAIDraftPayload(parsed, prompt);
}

export async function createCourseAIDraft(userId, payload) {
  const prompt = String(payload?.prompt || "")
    .trim()
    .slice(0, 4000);
  if (prompt.length < 20) {
    throw new ApiError(400, "Prompt must be at least 20 characters");
  }

  const aiDraft = await generateCourseDraftViaAI(prompt, {
    language: payload?.language,
    instructionalLevel: payload?.instructional_level,
  });

  const [categoryId, levelId] = await Promise.all([
    resolveAICategoryId(aiDraft.categoryHint),
    resolveLevelId(aiDraft.instructionalLevel),
  ]);

  const course = await createCourse(userId, {
    title: aiDraft.title,
    subtitle: aiDraft.subtitle,
    description: aiDraft.description,
    welcomeMessage: aiDraft.welcomeMessage || null,
    congratulationsMessage: aiDraft.congratulationsMessage || null,
    language: aiDraft.language,
    categoryId,
    levelId,
    published: false,
  });

  if (
    aiDraft.whatYouWillLearn.length > 0 ||
    aiDraft.requirements.length > 0 ||
    aiDraft.whoShouldAttend.length > 0
  ) {
    await updateCourseGoals(userId, course.id, {
      what_you_will_learn_data: aiDraft.whatYouWillLearn,
      requirements_data: aiDraft.requirements,
      who_should_attend_data: aiDraft.whoShouldAttend,
    });
  }
  const draftTopicCatalog = await loadAICourseTopicCatalog(categoryId);
  const supportsLessonTopics = Boolean(prisma.lessonTopic);
  const aiDraftFocusTerms = buildAIDraftFocusTerms(
    `${course.title} ${course.description || ""} ${prompt || ""}`,
  );

  for (let sectionIndex = 0; sectionIndex < aiDraft.sections.length; sectionIndex += 1) {
    const sectionPayload = aiDraft.sections[sectionIndex];
    const section = await prisma.courseSection.create({
      data: {
        courseId: course.id,
        title: sectionPayload.title,
        description: resolveSectionObjectiveText(
          sectionPayload.description,
          sectionPayload.title,
          course.title,
        ),
        position: sectionIndex + 1,
      },
    });

    const lessons = Array.isArray(sectionPayload.lessons)
      ? sectionPayload.lessons
      : [];
    for (let lessonIndex = 0; lessonIndex < lessons.length; lessonIndex += 1) {
      const lessonPayload = lessons[lessonIndex];
      const lessonType = normalizeAIDraftLessonType(lessonPayload.type);
      const resolvedLessonTitle =
        trimForDb(
          looksLikeGenericLessonTitle(lessonPayload.title)
            ? suggestLessonTitleFromTerms(
                sectionPayload.title,
                lessonIndex,
                aiDraftFocusTerms,
              )
            : lessonPayload.title,
          180,
        ) ||
        suggestLessonTitleFromTerms(
          sectionPayload.title,
          lessonIndex,
          aiDraftFocusTerms,
        );
      const bestTopic = pickBestTopicForAIGeneratedLesson(draftTopicCatalog, {
        topicHint: lessonPayload?.topic_hint || lessonPayload?.topic || "",
        title: resolvedLessonTitle,
        description: lessonPayload?.description || "",
        sectionTitle: sectionPayload?.title || "",
        courseTitle: course.title,
        courseDescription: course.description || "",
      });
      await prisma.lesson.create({
        data: {
          courseId: course.id,
          sectionId: section.id,
          topicId: bestTopic?.id || null,
          ...(supportsLessonTopics && bestTopic?.id
            ? {
                lessonTopics: {
                  create: [{ topicId: bestTopic.id }],
                },
              }
            : {}),
          type: lessonType,
          title: resolvedLessonTitle,
          description: resolveCurriculumDescriptionText(
            lessonPayload.description,
            resolvedLessonTitle,
            sectionPayload.title,
            course.title,
          ),
          assignmentText:
            lessonType === "RESOURCE" || lessonType === "ASSIGNMENT"
              ? resolveCurriculumDescriptionText(
                  lessonPayload.description,
                  resolvedLessonTitle,
                  sectionPayload.title,
                  course.title,
                )
              : null,
          position: lessonIndex + 1,
          durationInSeconds: Number(lessonPayload.durationInSeconds || 0),
          isPreview: sectionIndex === 0 && lessonIndex === 0,
        },
      });
    }
  }

  return {
    id: course.id,
    uuid: course.id,
    slug: course.slug,
    title: course.title,
    generated: {
      sections: aiDraft.sections.length,
      lessons: aiDraft.sections.reduce(
        (sum, section) => sum + (Array.isArray(section.lessons) ? section.lessons.length : 0),
        0,
      ),
    },
  };
}

export async function updateCourse(userId, courseId, payload) {
  const course = await prisma.course.findFirst({
    where: { id: courseId, deletedAt: null },
  });

  if (!course) {
    throw new ApiError(404, "Course not found");
  }

  if (course.educatorId !== userId) {
    throw new ApiError(403, "You can only update your own course");
  }
  const editableWorkflowStatuses = new Set(["DRAFT", "REJECTED", "PUBLISHED"]);
  if (!editableWorkflowStatuses.has(String(course.workflowStatus || "").toUpperCase())) {
    throw new ApiError(
      400,
      "Only draft, rejected, or published courses can be updated",
    );
  }

  const normalized = await normalizeCoursePayload(payload);
  if (normalized.slug !== undefined) {
    await assertCourseSlugAvailable(normalized.slug, course.id);
  }

  let updatedCourseId;
  try {
    updatedCourseId = await prisma.$transaction(async (tx) => {
      const updatedCourse = await tx.course.update({
        where: { id: courseId },
        data: normalized,
      });

      const coverImageId = extractMediaId(payload.cover_image);
      if (coverImageId) {
        await tx.media.updateMany({
          where: {
            id: coverImageId,
            userId,
            mediaType: { in: COVER_MEDIA_TYPES },
          },
          data: {
            courseId: updatedCourse.id,
            mediaType: "COVER_IMAGE",
          },
        });
      }

      const promoVideoId = extractMediaId(payload.promo_video);
      if (promoVideoId) {
        await tx.media.updateMany({
          where: {
            id: promoVideoId,
            userId,
            mediaType: { in: ["VIDEO", ...PROMO_MEDIA_TYPES] },
          },
          data: {
            courseId: updatedCourse.id,
            mediaType: "PROMO_VIDEO",
          },
        });
      }

      return updatedCourse.id;
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      throw new ApiError(409, "Slug already exists");
    }
    throw error;
  }

  const hydratedCourse = await prisma.course.findFirst({
    where: { id: updatedCourseId },
    include: getCourseInclude(),
  });
  if (!hydratedCourse) {
    throw new ApiError(404, "Course not found");
  }

  const coverImage = mapLegacyMedia(
    pickLatestMediaByTypes(hydratedCourse?.media, COVER_MEDIA_TYPES),
  );
  const promoVideo = mapLegacyMedia(
    pickLatestMediaByTypes(hydratedCourse?.media, PROMO_MEDIA_TYPES),
  );

  return {
    ...hydratedCourse,
    cover_image: coverImage,
    promo_video: promoVideo,
  };
}

export async function checkCourseSlugAvailability(slug, excludeCourseId = null) {
  const normalizedSlug = slugify(String(slug || ""))
    .slice(0, 150)
    .replace(/-+$/g, "");

  if (!normalizedSlug) {
    throw new ApiError(400, "slug is required");
  }

  const existing = await prisma.course.findFirst({
    where: {
      slug: normalizedSlug,
      deletedAt: null,
      id: excludeCourseId ? { not: excludeCourseId } : undefined,
    },
    select: { id: true },
  });

  return {
    slug: normalizedSlug,
    isAvailable: !existing,
  };
}

export async function updateCourseMessages(userId, courseId, payload) {
  const course = await prisma.course.findFirst({
    where: { id: courseId, deletedAt: null },
  });

  if (!course) {
    throw new ApiError(404, "Course not found");
  }
  if (course.educatorId !== userId) {
    throw new ApiError(403, "You can only update your own course");
  }

  const normalizeOptionalMessage = (value) => {
    if (value === undefined) return undefined;
    if (value === null) return null;
    const normalized = String(value).trim();
    return normalized.length ? normalized : null;
  };

  const welcomeMessage = normalizeOptionalMessage(
    payload.welcomeMessage ?? payload.welcome_message,
  );
  const congratulationsMessage = normalizeOptionalMessage(
    payload.congratulationsMessage ?? payload.congratulations_message,
  );

  if (welcomeMessage === undefined && congratulationsMessage === undefined) {
    throw new ApiError(
      400,
      "At least one of welcomeMessage or congratulationsMessage is required",
    );
  }

  return prisma.course.update({
    where: { id: courseId },
    data: {
      ...(welcomeMessage !== undefined ? { welcomeMessage } : {}),
      ...(congratulationsMessage !== undefined ? { congratulationsMessage } : {}),
    },
    select: {
      id: true,
      welcomeMessage: true,
      congratulationsMessage: true,
    },
  });
}

export async function updateCourseGoals(userId, courseId, payload) {
  const course = await prisma.course.findFirst({
    where: { id: courseId, deletedAt: null },
  });
  if (!course) {
    throw new ApiError(404, "Course not found");
  }
  if (course.educatorId !== userId) {
    throw new ApiError(403, "Forbidden");
  }

  const goals = normalizeGoalsPayload(payload);
  await prisma.platformSetting.upsert({
    where: { key: getCourseGoalsSettingKey(courseId) },
    update: {
      value: JSON.stringify(goals),
      description: `Goals for course ${courseId}`,
    },
    create: {
      key: getCourseGoalsSettingKey(courseId),
      value: JSON.stringify(goals),
      description: `Goals for course ${courseId}`,
    },
  });

  return goals;
}

export async function deleteDraftCourse(userId, courseId) {
  const course = await prisma.course.findFirst({
    where: { id: courseId, deletedAt: null },
  });

  if (!course) {
    throw new ApiError(404, "Course not found");
  }
  if (course.educatorId !== userId) {
    throw new ApiError(403, "Forbidden");
  }
  if (course.workflowStatus !== "DRAFT") {
    throw new ApiError(400, "Only draft courses can be deleted");
  }

  await prisma.course.update({
    where: { id: courseId },
    data: { deletedAt: new Date() },
  });
  return { success: true };
}

export async function submitCourseForApproval(userId, courseId, note) {
  const course = await prisma.course.findFirst({
    where: { id: courseId, deletedAt: null },
  });
  if (!course) {
    throw new ApiError(404, "Course not found");
  }
  if (course.educatorId !== userId) {
    throw new ApiError(403, "Forbidden");
  }
  const normalizedWorkflowStatus = String(course.workflowStatus || "").toUpperCase();
  if (!["DRAFT", "REJECTED"].includes(normalizedWorkflowStatus)) {
    throw new ApiError(400, "Only draft or rejected courses can be submitted");
  }

  return prisma.$transaction(async (tx) => {
    const updatedCourse = await tx.course.update({
      where: { id: courseId },
      data: {
        workflowStatus: "PENDING_APPROVAL",
        isDraftDeletable: false,
        submittedAt: new Date(),
      },
    });

    await tx.courseSubmission.create({
      data: {
        courseId,
        userId,
        note: note || null,
      },
    });

    return updatedCourse;
  });
}

export async function publishCourse(userId, courseId) {
  const course = await prisma.course.findFirst({
    where: { id: courseId, deletedAt: null },
  });

  if (!course) {
    throw new ApiError(404, "Course not found");
  }

  if (course.educatorId !== userId) {
    throw new ApiError(403, "Forbidden");
  }
  if (course.workflowStatus !== "APPROVED") {
    throw new ApiError(400, "Course must be approved before publishing");
  }

  return prisma.course.update({
    where: { id: courseId },
    data: {
      workflowStatus: "PUBLISHED",
      isPublished: true,
    },
  });
}

export async function unpublishCourse(userId, courseId) {
  const course = await prisma.course.findFirst({
    where: { id: courseId, deletedAt: null },
  });

  if (!course) {
    throw new ApiError(404, "Course not found");
  }
  if (course.educatorId !== userId) {
    throw new ApiError(403, "Forbidden");
  }

  return prisma.course.update({
    where: { id: courseId },
    data: {
      workflowStatus: "APPROVED",
      isPublished: false,
    },
  });
}

export async function listCourses(query, user) {
  const { page, limit, skip } = getPagination(query);
  const resolvedLevelId = await resolveLevelId(query.levelId || query.instructional_level);
  const searchTerm = toTrimmedString(query.search || query.q);
  const categorySlug = toTrimmedString(query.categorySlug || query.category_slug);
  const topicSlugs = toQueryList(query.topicSlug || query.topic_slug || query.topic);
  const priceFilters = toQueryList(query.price);
  const languageFilters = toQueryList(query.language).map((item) => item.toLowerCase());
  const handsOnFilters = toQueryList(query.handsOn || query.hands_on).map((item) =>
    item.toLowerCase(),
  );
  const minRating = Number(query.rating || 0);

  let resolvedCategoryIds = [];
  if (categorySlug) {
    const selectedCategory = await prisma.category.findFirst({
      where: {
        slug: categorySlug,
        deletedAt: null,
      },
      select: { id: true, parentId: true },
    });

    if (selectedCategory) {
      if (!selectedCategory.parentId) {
        const childCategories = await prisma.category.findMany({
          where: { parentId: selectedCategory.id, deletedAt: null },
          select: { id: true },
        });
        resolvedCategoryIds = [selectedCategory.id, ...childCategories.map((row) => row.id)];
      } else {
        resolvedCategoryIds = [selectedCategory.id];
      }
    }
  }

  let ratedCourseIds = null;
  if (Number.isFinite(minRating) && minRating > 0) {
    const ratingRows = await prisma.review.groupBy({
      by: ["courseId"],
      _avg: { rating: true },
      having: {
        rating: {
          _avg: {
            gte: minRating,
          },
        },
      },
    });
    ratedCourseIds = ratingRows.map((row) => row.courseId);
  }

  const lessonHandsOnOr = [];
  if (handsOnFilters.includes("quizzes")) {
    lessonHandsOnOr.push({ type: "QUIZ" });
  }
  if (handsOnFilters.includes("coding-exercise")) {
    lessonHandsOnOr.push({ type: "CODING_EXERCISE" });
  }
  if (handsOnFilters.includes("practice-tests")) {
    lessonHandsOnOr.push({
      title: { contains: "practice test", mode: "insensitive" },
    });
  }
  if (handsOnFilters.includes("role-plays")) {
    lessonHandsOnOr.push({
      title: { contains: "role play", mode: "insensitive" },
    });
  }

  const lessonConditions = [];
  if (topicSlugs.length) {
    lessonConditions.push({
      OR: [
        { topic: { slug: { in: topicSlugs }, deletedAt: null } },
        {
          lessonTopics: {
            some: {
              topic: { slug: { in: topicSlugs }, deletedAt: null },
            },
          },
        },
      ],
    });
  }
  if (lessonHandsOnOr.length) {
    lessonConditions.push({
      OR: lessonHandsOnOr,
    });
  }

  const where = {
    deletedAt: null,
    workflowStatus: user?.roles?.includes("ADMIN")
      ? undefined
      : query.includePending === "true" && user?.roles?.includes("EDUCATOR")
        ? undefined
        : "PUBLISHED",
    AND: [
      searchTerm
        ? {
            OR: [
              { title: { contains: searchTerm, mode: "insensitive" } },
              { subtitle: { contains: searchTerm, mode: "insensitive" } },
            ],
          }
        : undefined,
      languageFilters.length
        ? {
            OR: languageFilters.map((language) => ({
              language: { equals: language, mode: "insensitive" },
            })),
          }
        : undefined,
    ].filter(Boolean),
    categoryId:
      resolvedCategoryIds.length > 0
        ? { in: resolvedCategoryIds }
        : query.categoryId || query.category_id || undefined,
    levelId: resolvedLevelId || undefined,
    id: ratedCourseIds ? { in: ratedCourseIds } : undefined,
    priceTier:
      priceFilters.length === 1
        ? priceFilters[0] === "free"
          ? { price: { lte: 0 } }
          : priceFilters[0] === "paid"
            ? { price: { gt: 0 } }
            : undefined
        : undefined,
    lessons: lessonConditions.length
      ? {
          some: {
            AND: lessonConditions,
          },
        }
      : undefined,
  };

  const sort = toTrimmedString(query.sort || query.sortBy).toLowerCase();
  const orderBy =
    sort === "best_selling" || sort === "best-selling"
      ? [{ enrollments: { _count: "desc" } }, { createdAt: "desc" }]
      : { createdAt: "desc" };

  const [rows, total] = await Promise.all([
    prisma.course.findMany({
      where,
      skip,
      take: limit,
      include: {
        educator: {
          select: {
            id: true,
            email: true,
            username: true,
            firstName: true,
            lastName: true,
            headline: true,
          },
        },
        category: true,
        level: true,
        priceTier: true,
        sections: {
          include: {
            lessons: {
              select: { id: true, type: true },
            },
          },
        },
        media: {
          where: {
            mediaType: { in: [...COVER_MEDIA_TYPES, ...PROMO_MEDIA_TYPES] },
          },
          orderBy: { createdAt: "desc" },
        },
      },
      orderBy,
    }),
    prisma.course.count({ where }),
  ]);
  const courseIds = rows.map((row) => row.id);
  const ratingsByCourseId = new Map();

  if (courseIds.length) {
    const ratingAggregates = await prisma.review.groupBy({
      by: ["courseId"],
      where: { courseId: { in: courseIds } },
      _avg: { rating: true },
      _count: { rating: true },
    });

    for (const row of ratingAggregates) {
      ratingsByCourseId.set(row.courseId, {
        average_rating: Number(row?._avg?.rating || 0),
        total_reviews: Number(row?._count?.rating || 0),
      });
    }
  }

  let cartCourseIds = new Set();
  let enrolledCourseIds = new Set();

  if (user?.id) {
    const [cartRows, enrollmentRows] = await Promise.all([
      prisma.cartItem.findMany({
        where: {
          cart: { userId: user.id },
        },
        select: { courseId: true },
      }),
      prisma.enrollment.findMany({
        where: {
          userId: user.id,
          status: "ACTIVE",
        },
        select: { courseId: true },
      }),
    ]);

    cartCourseIds = new Set(cartRows.map((row) => row.courseId));
    enrolledCourseIds = new Set(enrollmentRows.map((row) => row.courseId));
  }

  const courseGoalsMap = await readCourseGoalsMap(rows.map((course) => course.id));
  const educatorPicturesByUserId = await getLatestUserPicturesMap(
    rows.map((course) => course?.educator?.id),
  );

  const mappedRows = rows.map((course) => ({
    ...course,
    educator: course.educator
      ? {
          ...course.educator,
          user_picture: educatorPicturesByUserId.get(course.educator.id) || null,
        }
      : null,
    goals: courseGoalsMap.get(course.id) || normalizeGoalsPayload({}),
    is_in_cart: cartCourseIds.has(course.id),
    is_enrolled: enrolledCourseIds.has(course.id),
    stats: {
      average_rating: ratingsByCourseId.get(course.id)?.average_rating || 0,
      total_reviews: ratingsByCourseId.get(course.id)?.total_reviews || 0,
    },
  }));

  return toPagedResult(mappedRows, total, page, limit);
}

export async function getCourseDiscoveryData(query = {}) {
  const search = toTrimmedString(query.q || query.search);
  const limit = clampInteger(query.limit, 1, 12, 6);
  const days = clampInteger(query.days, 1, 365, 30);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const publishedCourses = await prisma.course.findMany({
    where: {
      deletedAt: null,
      workflowStatus: "PUBLISHED",
    },
    include: {
      educator: {
        select: { id: true, username: true, firstName: true, lastName: true },
      },
      category: {
        include: {
          parent: {
            select: { id: true, name: true, slug: true, parentId: true },
          },
        },
      },
      media: {
        where: {
          mediaType: { in: [...COVER_MEDIA_TYPES, ...PROMO_MEDIA_TYPES] },
        },
        orderBy: { createdAt: "desc" },
      },
      _count: {
        select: {
          enrollments: true,
          reviews: true,
          wishlists: true,
          cartItems: true,
        },
      },
    },
    orderBy: { updatedAt: "desc" },
    take: 500,
  });

  const courseIds = publishedCourses.map((course) => course.id);
  const pageViewsByCourseId = new Map();
  const impressionsByCourseId = new Map();

  if (courseIds.length > 0 && prisma.activityEvent) {
    try {
      const analyticsRows = await prisma.activityEvent.groupBy({
        by: ["courseId", "eventType"],
        where: {
          courseId: { in: courseIds },
          createdAt: { gte: since },
          eventType: { in: ["COURSE_IMPRESSION", "COURSE_PAGE_VIEW"] },
        },
        _count: { _all: true },
      });

      for (const row of analyticsRows) {
        if (!row.courseId) continue;
        if (row.eventType === "COURSE_PAGE_VIEW") {
          pageViewsByCourseId.set(row.courseId, row._count._all);
        } else if (row.eventType === "COURSE_IMPRESSION") {
          impressionsByCourseId.set(row.courseId, row._count._all);
        }
      }
    } catch (_error) {}
  }

  const scoredCourses = publishedCourses.map((course) =>
    createScoredCourseRow(course, {
      enrollments: course?._count?.enrollments || 0,
      reviews: course?._count?.reviews || 0,
      wishlists: course?._count?.wishlists || 0,
      cartItems: course?._count?.cartItems || 0,
      pageViews: pageViewsByCourseId.get(course.id) || 0,
      impressions: impressionsByCourseId.get(course.id) || 0,
    }),
  );

  const sortedByTrend = [...scoredCourses].sort((a, b) => {
    if (b.trendScore !== a.trendScore) return b.trendScore - a.trendScore;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });

  const trendingCourses = sortedByTrend.slice(0, limit).map(mapDiscoveryCourseItem);
  const suggestedCourses = [...scoredCourses]
    .sort((a, b) => {
      const aRecency = new Date(a.updatedAt).getTime();
      const bRecency = new Date(b.updatedAt).getTime();
      if (bRecency !== aRecency) return bRecency - aRecency;
      return b.trendScore - a.trendScore;
    })
    .slice(0, limit)
    .map(mapDiscoveryCourseItem);

  const categoryTrendMap = new Map();
  const subcategoryTrendMap = new Map();
  const scoreByCourseId = new Map(scoredCourses.map((course) => [course.id, course.trendScore || 0]));

  for (const course of scoredCourses) {
    const category = course.category;
    if (!category) continue;
    const score = course.trendScore || 0;
    const rootCategory = category.parent || category;

    if (!categoryTrendMap.has(rootCategory.id)) {
      categoryTrendMap.set(rootCategory.id, {
        id: rootCategory.id,
        slug: rootCategory.slug,
        title: rootCategory.name,
        score: 0,
        course_count: 0,
      });
    }
    const rootEntry = categoryTrendMap.get(rootCategory.id);
    rootEntry.score += score;
    rootEntry.course_count += 1;

    if (category.parentId) {
      if (!subcategoryTrendMap.has(category.id)) {
        subcategoryTrendMap.set(category.id, {
          id: category.id,
          slug: category.slug,
          title: category.name,
          parent_category_id: rootCategory.id,
          parent_category_title: rootCategory.name,
          parent_category_slug: rootCategory.slug,
          score: 0,
          course_count: 0,
        });
      }
      const subEntry = subcategoryTrendMap.get(category.id);
      subEntry.score += score;
      subEntry.course_count += 1;
    }
  }

  const topicSourceCourseIds = sortedByTrend.slice(0, 200).map((course) => course.id);
  const topicTrendMap = new Map();

  if (topicSourceCourseIds.length > 0) {
    const lessons = await prisma.lesson.findMany({
      where: { courseId: { in: topicSourceCourseIds } },
      select: {
        courseId: true,
        topic: {
          select: {
            id: true,
            slug: true,
            name: true,
            category: {
              select: {
                id: true,
                name: true,
                slug: true,
                parent: { select: { id: true, name: true, slug: true } },
              },
            },
          },
        },
        lessonTopics: {
          select: {
            topic: {
              select: {
                id: true,
                slug: true,
                name: true,
                category: {
                  select: {
                    id: true,
                    name: true,
                    slug: true,
                    parent: { select: { id: true, name: true, slug: true } },
                  },
                },
              },
            },
          },
        },
      },
    });

    const topicsByCourse = new Map();

    for (const lesson of lessons) {
      if (!topicsByCourse.has(lesson.courseId)) {
        topicsByCourse.set(lesson.courseId, new Map());
      }

      const topicMap = topicsByCourse.get(lesson.courseId);
      if (lesson.topic?.id) {
        topicMap.set(lesson.topic.id, lesson.topic);
      }
      for (const row of lesson.lessonTopics || []) {
        if (row?.topic?.id) {
          topicMap.set(row.topic.id, row.topic);
        }
      }
    }

    for (const [courseId, topicMap] of topicsByCourse.entries()) {
      const score = scoreByCourseId.get(courseId) || 0;
      for (const topic of topicMap.values()) {
        if (!topicTrendMap.has(topic.id)) {
          topicTrendMap.set(topic.id, {
            id: topic.id,
            slug: topic.slug,
            title: topic.name,
            category_id: topic.category?.id || null,
            category_title: topic.category?.name || null,
            category_slug: topic.category?.slug || null,
            parent_category_id: topic.category?.parent?.id || null,
            parent_category_title: topic.category?.parent?.name || null,
            parent_category_slug: topic.category?.parent?.slug || null,
            score: 0,
            course_count: 0,
          });
        }
        const entry = topicTrendMap.get(topic.id);
        entry.score += score;
        entry.course_count += 1;
      }
    }
  }

  const sortTrendRows = (rows) =>
    rows
      .map((row) => ({
        ...row,
        score: Number((row.score || 0).toFixed(2)),
      }))
      .sort((a, b) => {
        if ((b.score || 0) !== (a.score || 0)) return (b.score || 0) - (a.score || 0);
        return (b.course_count || 0) - (a.course_count || 0);
      });

  const trendingCategories = sortTrendRows(Array.from(categoryTrendMap.values())).slice(0, 12);
  const trendingSubcategories = sortTrendRows(Array.from(subcategoryTrendMap.values())).slice(0, 12);
  const trendingTopics = sortTrendRows(Array.from(topicTrendMap.values())).slice(0, 12);

  const normalizedSearch = search.toLowerCase();
  const matchedCourses =
    normalizedSearch.length > 0
      ? sortedByTrend
          .filter((course) => toCourseSearchText(course).toLowerCase().includes(normalizedSearch))
          .slice(0, limit)
          .map(mapDiscoveryCourseItem)
      : [];

  const matchedTopics =
    normalizedSearch.length > 0
      ? sortTrendRows(Array.from(topicTrendMap.values()))
          .filter((topic) => String(topic.title || "").toLowerCase().includes(normalizedSearch))
          .slice(0, limit)
      : [];

  const matchedUsers =
    normalizedSearch.length > 0
      ? (
          await prisma.user.findMany({
            where: {
              deletedAt: null,
              isActive: true,
              courses: {
                some: {
                  deletedAt: null,
                  workflowStatus: "PUBLISHED",
                },
              },
              OR: [
                { username: { contains: search, mode: "insensitive" } },
                { firstName: { contains: search, mode: "insensitive" } },
                { lastName: { contains: search, mode: "insensitive" } },
                { headline: { contains: search, mode: "insensitive" } },
              ],
            },
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
              headline: true,
            },
            take: limit,
            orderBy: { updatedAt: "desc" },
          })
        ).map((user) => ({
          id: user.id,
          username: user.username,
          first_name: user.firstName || "",
          last_name: user.lastName || "",
          headline: user.headline || "",
        }))
      : [];

  return {
    range_days: days,
    trending_courses: trendingCourses,
    suggested_courses: suggestedCourses,
    trending_topics: trendingTopics,
    trending_categories: trendingCategories,
    trending_subcategories: trendingSubcategories,
    suggestions: {
      query: search,
      topics: matchedTopics,
      courses: matchedCourses,
      users: matchedUsers,
      suggested_courses: suggestedCourses,
      trending_courses: trendingCourses,
    },
  };
}

export async function getCourseBySlug(slug) {
  const course = await prisma.course.findFirst({
    where: {
      OR: [{ slug }, { id: slug }],
      deletedAt: null,
    },
    include: {
      educator: { select: { id: true, username: true } },
      category: true,
      level: true,
      priceTier: true,
      media: {
        where: {
          mediaType: { in: [...COVER_MEDIA_TYPES, ...PROMO_MEDIA_TYPES] },
        },
        orderBy: { createdAt: "desc" },
      },
      sections: {
        orderBy: { position: "asc" },
        include: {
          lessons: {
            orderBy: { position: "asc" },
            include: {
              media: {
                orderBy: { createdAt: "desc" },
                take: 1,
              },
            },
          },
        },
      },
      reviews: {
        select: { rating: true },
      },
    },
  });

  if (!course) {
    throw new ApiError(404, "Course not found");
  }

  const avgRating = course.reviews.length
    ? course.reviews.reduce((acc, review) => acc + review.rating, 0) /
      course.reviews.length
    : 0;

  const goals = await readCourseGoals(course.id);

  return mapCourseDetails(course, goals);
}

function mapCourseDetails(course, goals) {
  const avgRating = course.reviews.length
    ? course.reviews.reduce((acc, review) => acc + review.rating, 0) /
      course.reviews.length
    : 0;
  const totalVideoCount = course.sections.reduce(
    (acc, section) =>
      acc + section.lessons.filter((lesson) => lesson.type === "VIDEO").length,
    0,
  );
  const totalArticleCount = course.sections.reduce(
    (acc, section) =>
      acc + section.lessons.filter((lesson) => lesson.type === "RESOURCE").length,
    0,
  );

  return {
    ...course,
    uuid: course.id,
    welcome_message: course.welcomeMessage || "",
    congratulations_message: course.congratulationsMessage || "",
    cover_image: mapLegacyMedia(
      pickLatestMediaByTypes(course.media, COVER_MEDIA_TYPES),
    ),
    promo_video: mapLegacyMedia(
      pickLatestMediaByTypes(course.media, PROMO_MEDIA_TYPES),
    ),
    instructional_level: course.level
      ? { id: course.level.id, title: course.level.title }
      : null,
    price_tier: course.priceTier
      ? {
          id: course.priceTier.id,
          title: course.priceTier.title,
          price: String(course.priceTier.price),
        }
      : null,
    category_ids: course.category ? [{ category_id: course.category.id }] : [],
    author: {
      data: {
        id: course.educator?.id || null,
        username: course.educator?.username || "",
        firstname: course.educator?.firstName || "",
        lastname: course.educator?.lastName || "",
        headline: course.educator?.headline || "",
        biography: course.educator?.biography || "",
        user_picture: null,
      },
    },
    sections: course.sections.map((section) => ({
      id: section.id,
      uuid: section.id,
      title: section.title,
      curriculums: section.lessons.map((lesson) => {
        const parsedQuizQuestions = safeParseJson(lesson.quizQuestions);
        const parsedStarterCode = safeParseJson(lesson.codingStarterCode);

        return {
          id: lesson.id,
          uuid: lesson.id,
          title: lesson.title,
          curriculum_resource_type:
            lesson.type === "QUIZ"
              ? "quiz"
              : lesson.type === "CODING_EXERCISE"
                ? "coding_exercise"
                : lesson.videoUrl || lesson.type === "VIDEO"
                  ? "video"
                  : lesson.assignmentText || lesson.type === "RESOURCE"
                    ? "article"
                    : "null",
          topic_id: lesson.topicId || null,
          estimated_duration: estimateLessonDurationSeconds(lesson),
          curriculum_description: lesson.description || "",
          asset:
            lesson.type === "QUIZ"
              ? {
                  questions: Array.isArray(parsedQuizQuestions)
                    ? parsedQuizQuestions
                    : parsedQuizQuestions?.questions || [],
                }
              : lesson.type === "CODING_EXERCISE"
                ? {
                    instructions: lesson.codingInstructions || "",
                    starter_code:
                      parsedStarterCode?.starter_code || parsedStarterCode || {},
                    expected_output: parsedStarterCode?.expected_output || {},
                    languages: parsedStarterCode?.languages || [],
                    test_cases_visible: normalizeVisibleCodingTests(parsedStarterCode),
                    step_challenges:
                      parsedStarterCode?.step_challenges &&
                      typeof parsedStarterCode.step_challenges === "object"
                        ? parsedStarterCode.step_challenges
                        : {},
                    checklist: normalizeStringArray(parsedStarterCode?.checklist),
                    hints: normalizeStringArray(parsedStarterCode?.hints),
                  }
                : lesson.videoUrl || lesson.type === "VIDEO"
                  ? {
                      id: lesson.id,
                      path: `/stream.php?id=${encodeURIComponent(lesson.id)}`,
                    }
                  : lesson.assignmentText
                    ? { id: lesson.id, content: lesson.assignmentText }
                    : null,
        };
      }),
    })),
    resources_count: {
      section_count: course.sections.length,
      curriculum_count: course.sections.reduce(
        (acc, section) => acc + section.lessons.length,
        0,
      ),
      video_count: totalVideoCount,
      article_count: totalArticleCount,
    },
    goals,
    averageRating: Number(avgRating.toFixed(2)),
    reviewsCount: course.reviews.length,
  };
}

export async function getCourseForManagement(user, slug) {
  const course = await prisma.course.findFirst({
    where: {
      OR: [{ slug }, { id: slug }],
      deletedAt: null,
    },
    include: {
      educator: {
        select: {
          id: true,
          username: true,
          firstName: true,
          lastName: true,
          headline: true,
          biography: true,
        },
      },
      category: true,
      level: true,
      priceTier: true,
      media: {
        where: {
          mediaType: { in: [...COVER_MEDIA_TYPES, ...PROMO_MEDIA_TYPES] },
        },
        orderBy: { createdAt: "desc" },
      },
      sections: {
        orderBy: { position: "asc" },
        include: {
          lessons: {
            orderBy: { position: "asc" },
            include: {
              media: {
                orderBy: { createdAt: "desc" },
                take: 1,
              },
            },
          },
        },
      },
      reviews: {
        select: { rating: true },
      },
    },
  });

  if (!course) {
    throw new ApiError(404, "Course not found");
  }

  const isOwner = course.educatorId === user?.id;
  const isAdmin = Array.isArray(user?.roles) && user.roles.includes("ADMIN");
  if (!isOwner && !isAdmin) {
    throw new ApiError(403, "Forbidden");
  }

  const goals = await readCourseGoals(course.id);
  return mapCourseDetails(course, goals);
}

async function resolveCourseForManagementAccess(user, slug) {
  const course = await prisma.course.findFirst({
    where: {
      OR: [{ slug }, { id: slug }],
      deletedAt: null,
    },
    select: {
      id: true,
      slug: true,
      educatorId: true,
    },
  });

  if (!course) {
    throw new ApiError(404, "Course not found");
  }

  const isOwner = course.educatorId === user?.id;
  const isAdmin = Array.isArray(user?.roles) && user.roles.includes("ADMIN");
  if (!isOwner && !isAdmin) {
    throw new ApiError(403, "Forbidden");
  }

  return course;
}

export async function getCourseStudentsForManagement(user, slug, query = {}) {
  const course = await resolveCourseForManagementAccess(user, slug);

  const { page, limit, skip } = getPagination(query);
  const search = String(query.search || query.q || "")
    .trim()
    .slice(0, 120);

  const activeEnrollmentWhere = {
    courseId: course.id,
    status: { in: ["ACTIVE", "COMPLETED"] },
  };

  const searchUserFilter = search
    ? {
        OR: [
          { firstName: { contains: search, mode: "insensitive" } },
          { lastName: { contains: search, mode: "insensitive" } },
          { username: { contains: search, mode: "insensitive" } },
        ],
      }
    : undefined;

  const listWhere = {
    ...activeEnrollmentWhere,
    user: searchUserFilter,
  };

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const [totalStudents, increaseThisMonth, allProgressRows, rows, total] =
    await Promise.all([
      prisma.enrollment.count({ where: activeEnrollmentWhere }),
      prisma.enrollment.count({
        where: {
          ...activeEnrollmentWhere,
          enrolledAt: { gte: startOfMonth },
        },
      }),
      prisma.enrollment.findMany({
        where: activeEnrollmentWhere,
        select: {
          courseProgress: {
            select: { progressPct: true },
          },
        },
      }),
      prisma.enrollment.findMany({
        where: listWhere,
        skip,
        take: limit,
        orderBy: { enrolledAt: "desc" },
        select: {
          id: true,
          status: true,
          enrolledAt: true,
          completedAt: true,
          user: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              username: true,
            },
          },
          courseProgress: {
            select: {
              progressPct: true,
              completedLessons: true,
              totalLessons: true,
              completedAt: true,
            },
          },
        },
      }),
      prisma.enrollment.count({ where: listWhere }),
    ]);

  const averageProgressPct = totalStudents
    ? Number(
        (
          allProgressRows.reduce(
            (sum, row) => sum + Number(row.courseProgress?.progressPct || 0),
            0,
          ) / totalStudents
        ).toFixed(2),
      )
    : 0;

  const mappedRows = rows.map((row) => {
    const progressPct = Number(row.courseProgress?.progressPct || 0);
    const firstName = row.user?.firstName || "";
    const lastName = row.user?.lastName || "";
    const fullName = `${firstName} ${lastName}`.trim();

    return {
      enrollment_id: row.id,
      student: {
        id: row.user?.id || null,
        name: fullName || row.user?.username || "Unknown",
        username: row.user?.username || "",
      },
      enrollment_date: row.enrolledAt,
      status: row.status,
      progress: {
        progress_pct: progressPct,
        completed_lessons: row.courseProgress?.completedLessons || 0,
        total_lessons: row.courseProgress?.totalLessons || 0,
        completed:
          progressPct >= 100 ||
          row.status === "COMPLETED" ||
          Boolean(row.completedAt || row.courseProgress?.completedAt),
      },
    };
  });

  return {
    stats: {
      total_students: totalStudents,
      increase_this_month: increaseThisMonth,
      average_progress_pct: averageProgressPct,
    },
    ...toPagedResult(mappedRows, total, page, limit),
  };
}

export async function getCourseStatisticsForManagement(user, slug) {
  const course = await resolveCourseForManagementAccess(user, slug);
  const activityEventModel = prisma.activityEvent || null;

  const activeEnrollmentWhere = {
    courseId: course.id,
    status: { in: ["ACTIVE", "COMPLETED"] },
  };

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const enrollmentTrendStart = new Date(startOfMonth);
  enrollmentTrendStart.setMonth(enrollmentTrendStart.getMonth() - 5);

  const roundMoney = (value) => Number(Number(value || 0).toFixed(2));
  const allocateByWeights = (totalAmount, weightedItems = []) => {
    const normalizedTotal = Math.max(0, roundMoney(totalAmount));
    if (!normalizedTotal || !weightedItems.length) return new Map();

    const items = weightedItems.map((item) => ({
      id: item.id,
      weight: Math.max(0, Number(item.weight || 0)),
    }));
    const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
    if (totalWeight <= 0) return new Map();

    const totalCents = Math.round(normalizedTotal * 100);
    const rawCents = items.map((item) => (item.weight / totalWeight) * totalCents);
    const baseCents = rawCents.map((value) => Math.floor(value));
    let remaining = totalCents - baseCents.reduce((sum, value) => sum + value, 0);

    const ranked = rawCents
      .map((value, index) => ({ index, remainder: value - baseCents[index] }))
      .sort((a, b) => b.remainder - a.remainder);

    let cursor = 0;
    while (remaining > 0) {
      const target = ranked[cursor % ranked.length];
      baseCents[target.index] += 1;
      remaining -= 1;
      cursor += 1;
    }

    const allocations = new Map();
    items.forEach((item, index) => {
      allocations.set(item.id, Number((baseCents[index] / 100).toFixed(2)));
    });
    return allocations;
  };

  const [
    totalStudents,
    enrollmentsThisMonth,
    completedStudents,
    progressRows,
    reviewAggregate,
    ratingBuckets,
    enrollmentTrendRows,
    totalImpressions,
    uniqueImpressionUsers,
    uniqueImpressionSessions,
  ] = await Promise.all([
    prisma.enrollment.count({ where: activeEnrollmentWhere }),
    prisma.enrollment.count({
      where: {
        ...activeEnrollmentWhere,
        enrolledAt: { gte: startOfMonth },
      },
    }),
    prisma.enrollment.count({
      where: {
        ...activeEnrollmentWhere,
        OR: [{ status: "COMPLETED" }, { completedAt: { not: null } }],
      },
    }),
    prisma.enrollment.findMany({
      where: activeEnrollmentWhere,
      select: {
        courseProgress: {
          select: { progressPct: true },
        },
      },
    }),
    prisma.review.aggregate({
      where: { courseId: course.id },
      _avg: { rating: true },
      _count: { rating: true },
    }),
    prisma.review.groupBy({
      by: ["rating"],
      where: { courseId: course.id },
      _count: { rating: true },
    }),
    prisma.enrollment.findMany({
      where: {
        ...activeEnrollmentWhere,
        enrolledAt: { gte: enrollmentTrendStart },
      },
      select: { enrolledAt: true },
    }),
    activityEventModel
      ? activityEventModel.count({
          where: {
            courseId: course.id,
            eventType: "COURSE_IMPRESSION",
          },
        })
      : Promise.resolve(0),
    activityEventModel
      ? activityEventModel.findMany({
          where: {
            courseId: course.id,
            eventType: "COURSE_IMPRESSION",
            userId: { not: null },
          },
          distinct: ["userId"],
          select: { userId: true },
        })
      : Promise.resolve([]),
    activityEventModel
      ? activityEventModel.findMany({
          where: {
            courseId: course.id,
            eventType: "COURSE_IMPRESSION",
            sessionKey: { not: null },
          },
          distinct: ["sessionKey"],
          select: { sessionKey: true },
        })
      : Promise.resolve([]),
  ]);

  const paidCourseOrderItems = await prisma.orderItem.findMany({
    where: {
      courseId: course.id,
      order: { status: "PAID" },
    },
    select: {
      id: true,
      orderId: true,
      createdAt: true,
      unitPrice: true,
      discountAmount: true,
      platformFeePercent: true,
      order: {
        select: {
          discountAmount: true,
        },
      },
    },
  });

  const relatedOrderIds = Array.from(
    new Set(paidCourseOrderItems.map((item) => item.orderId).filter(Boolean)),
  );
  const relatedOrderItems = relatedOrderIds.length
    ? await prisma.orderItem.findMany({
        where: {
          orderId: { in: relatedOrderIds },
        },
        select: {
          id: true,
          orderId: true,
          unitPrice: true,
          discountAmount: true,
        },
      })
    : [];

  const orderItemsMap = relatedOrderItems.reduce((map, item) => {
    if (!map.has(item.orderId)) {
      map.set(item.orderId, []);
    }
    map.get(item.orderId).push(item);
    return map;
  }, new Map());

  const allocatedOrderDiscountByItemId = new Map();
  for (const [orderId, items] of orderItemsMap.entries()) {
    const sampleCourseItem = paidCourseOrderItems.find((item) => item.orderId === orderId);
    const orderDiscount = Number(sampleCourseItem?.order?.discountAmount || 0);
    if (orderDiscount <= 0) continue;

    const explicitDiscountSum = items.reduce(
      (sum, item) => sum + Number(item.discountAmount || 0),
      0,
    );
    const remainingOrderDiscount = roundMoney(
      Math.max(0, orderDiscount - explicitDiscountSum),
    );
    if (remainingOrderDiscount <= 0) continue;

    const zeroDiscountItems = items.filter(
      (item) => Number(item.discountAmount || 0) <= 0,
    );
    if (!zeroDiscountItems.length) continue;

    const allocations = allocateByWeights(
      remainingOrderDiscount,
      zeroDiscountItems.map((item) => ({
        id: item.id,
        weight: Number(item.unitPrice || 0),
      })),
    );
    allocations.forEach((value, key) => {
      allocatedOrderDiscountByItemId.set(key, value);
    });
  }

  let totalRevenue = 0;
  let revenueThisMonth = 0;
  for (const item of paidCourseOrderItems) {
    const unitPrice = Number(item.unitPrice || 0);
    const explicitDiscount = Number(item.discountAmount || 0);
    const distributedDiscount = Number(
      allocatedOrderDiscountByItemId.get(item.id) || 0,
    );
    const effectiveDiscount = roundMoney(
      Math.min(unitPrice, explicitDiscount + distributedDiscount),
    );
    const taxableAmount = roundMoney(Math.max(0, unitPrice - effectiveDiscount));
    const platformFeePercent = Number(item.platformFeePercent || 0);
    const platformFeeAmount = roundMoney(
      (taxableAmount * platformFeePercent) / 100,
    );
    const educatorNetRevenue = roundMoney(
      Math.max(0, taxableAmount - platformFeeAmount),
    );

    totalRevenue += educatorNetRevenue;
    if (item.createdAt >= startOfMonth) {
      revenueThisMonth += educatorNetRevenue;
    }
  }

  const averageProgressPct = totalStudents
    ? Number(
        (
          progressRows.reduce(
            (sum, row) => sum + Number(row.courseProgress?.progressPct || 0),
            0,
          ) / totalStudents
        ).toFixed(2),
      )
    : 0;
  const completionRatePct = totalStudents
    ? Number(((completedStudents / totalStudents) * 100).toFixed(2))
    : 0;
  const totalReviews = Number(reviewAggregate?._count?.rating || 0);

  const rating_distribution = [5, 4, 3, 2, 1].map((ratingValue) => {
    const bucket = ratingBuckets.find((row) => row.rating === ratingValue);
    const count = Number(bucket?._count?.rating || 0);
    return {
      rating: ratingValue,
      count,
      percentage: totalReviews ? Number(((count / totalReviews) * 100).toFixed(2)) : 0,
    };
  });

  const monthFormatter = new Intl.DateTimeFormat("en-US", { month: "short" });
  const monthly_enrollments = Array.from({ length: 6 }).map((_, index) => {
    const date = new Date(enrollmentTrendStart);
    date.setMonth(enrollmentTrendStart.getMonth() + index);
    const month = date.getMonth();
    const year = date.getFullYear();
    const count = enrollmentTrendRows.filter(
      (row) =>
        row.enrolledAt.getMonth() === month &&
        row.enrolledAt.getFullYear() === year,
    ).length;

    return {
      month,
      year,
      label: `${monthFormatter.format(date)} ${year}`,
      count,
    };
  });

  return {
    overview: {
      total_students: totalStudents,
      enrollments_this_month: enrollmentsThisMonth,
      completed_students: completedStudents,
      completion_rate_pct: completionRatePct,
      average_progress_pct: averageProgressPct,
      average_rating: Number(reviewAggregate?._avg?.rating || 0),
      total_reviews: totalReviews,
      total_revenue: roundMoney(totalRevenue),
      revenue_this_month: roundMoney(revenueThisMonth),
      total_impressions: totalImpressions,
      unique_impression_visitors: Math.max(
        uniqueImpressionUsers.length,
        uniqueImpressionSessions.length,
      ),
    },
    distribution: {
      rating_distribution,
    },
    trends: {
      monthly_enrollments,
    },
  };
}

export async function listAuthoredCourses(userId, query) {
  const { page, limit, skip } = getPagination(query);
  const resolvedLevelId = await resolveLevelId(query.instructional_level || query.levelId);
  const where = {
    educatorId: userId,
    deletedAt: null,
    title: query.title ? { contains: query.title, mode: "insensitive" } : undefined,
    levelId: resolvedLevelId || undefined,
  };

  const [rows, total] = await Promise.all([
    prisma.course.findMany({
      where,
      skip,
      take: limit,
      include: getCourseInclude(),
      orderBy: { createdAt: "desc" },
    }),
    prisma.course.count({ where }),
  ]);

  const courseIds = rows.map((row) => row.id);
  if (!courseIds.length) {
    return toPagedResult(rows, total, page, limit);
  }

  const startOfMonth = new Date();
  startOfMonth.setDate(1);
  startOfMonth.setHours(0, 0, 0, 0);

  const [monthlyEnrollments, totalEnrollments, ratingAggregates] = await Promise.all([
    prisma.enrollment.groupBy({
      by: ["courseId"],
      where: {
        courseId: { in: courseIds },
        status: { in: ["ACTIVE", "COMPLETED"] },
        enrolledAt: { gte: startOfMonth },
      },
      _count: { _all: true },
    }),
    prisma.enrollment.groupBy({
      by: ["courseId"],
      where: {
        courseId: { in: courseIds },
        status: { in: ["ACTIVE", "COMPLETED"] },
      },
      _count: { _all: true },
    }),
    prisma.review.groupBy({
      by: ["courseId"],
      where: { courseId: { in: courseIds } },
      _avg: { rating: true },
      _count: { rating: true },
    }),
  ]);

  const monthlyByCourseId = new Map(
    monthlyEnrollments.map((row) => [row.courseId, Number(row?._count?._all || 0)]),
  );
  const totalEnrollmentsByCourseId = new Map(
    totalEnrollments.map((row) => [row.courseId, Number(row?._count?._all || 0)]),
  );
  const ratingsByCourseId = new Map(
    ratingAggregates.map((row) => [
      row.courseId,
      {
        average_rating: Number(row?._avg?.rating || 0),
        total_reviews: Number(row?._count?.rating || 0),
      },
    ]),
  );

  const withStats = rows.map((row) => ({
    ...row,
    educator: row.educator
      ? {
          ...row.educator,
          user_picture: null,
        }
      : null,
    stats: {
      enrollments_this_month: monthlyByCourseId.get(row.id) || 0,
      total_enrollments: totalEnrollmentsByCourseId.get(row.id) || 0,
      average_rating: ratingsByCourseId.get(row.id)?.average_rating || 0,
      total_reviews: ratingsByCourseId.get(row.id)?.total_reviews || 0,
    },
  }));

  const educatorPicturesByUserId = await getLatestUserPicturesMap(
    withStats.map((course) => course?.educator?.id),
  );

  const withStatsAndPictures = withStats.map((course) => ({
    ...course,
    educator: course.educator
      ? {
          ...course.educator,
          user_picture: educatorPicturesByUserId.get(course.educator.id) || null,
        }
      : null,
  }));

  return toPagedResult(withStatsAndPictures, total, page, limit);
}

function canViewCourseRoute(course, actor) {
  if (!course || course.deletedAt) return false;
  if (course.workflowStatus === "PUBLISHED") return true;

  if (!actor?.id) return false;
  if (Array.isArray(actor.roles) && actor.roles.includes("ADMIN")) return true;
  if (course.educatorId === actor.id) return true;

  return false;
}

export async function getCourseRoute(slug, actor = null) {
  const course = await prisma.course.findFirst({
    where: {
      slug,
      deletedAt: null,
    },
    include: {
      educator: { select: { id: true, username: true, firstName: true, lastName: true } },
      category: true,
      level: true,
      priceTier: true,
      media: {
        where: {
          mediaType: { in: [...COVER_MEDIA_TYPES, ...PROMO_MEDIA_TYPES] },
        },
        orderBy: { createdAt: "desc" },
      },
      sections: {
        orderBy: { position: "asc" },
        include: {
          lessons: {
            orderBy: { position: "asc" },
            include: {
              topic: {
                select: {
                  id: true,
                  slug: true,
                  name: true,
                },
              },
              lessonTopics: {
                select: {
                  topic: {
                    select: {
                      id: true,
                      slug: true,
                      name: true,
                    },
                  },
                },
              },
            },
          },
        },
      },
      reviews: {
        select: { rating: true },
      },
    },
  });

  if (!course) {
    throw new ApiError(404, "Course not found");
  }
  if (!canViewCourseRoute(course, actor)) {
    throw new ApiError(404, "Course not found");
  }

  const [isEnrolled, isInCart, isInWishlist, activePromotionCouponRows] = await Promise.all([
    actor?.id
      ? prisma.enrollment.findFirst({ where: { userId: actor.id, courseId: course.id } })
      : Promise.resolve(null),
    actor?.id
      ? prisma.cartItem.findFirst({
          where: {
            courseId: course.id,
            cart: { userId: actor.id },
          },
        })
      : Promise.resolve(null),
    actor?.id
      ? prisma.wishlist.findFirst({
          where: {
            userId: actor.id,
            courseId: course.id,
          },
        })
      : Promise.resolve(null),
    prisma.coupon.findMany({
      where: {
        courseId: course.id,
        isActive: true,
        deletedAt: null,
        OR: [{ startsAt: null }, { startsAt: { lte: new Date() } }],
        AND: [{ OR: [{ endsAt: null }, { endsAt: { gte: new Date() } }] }],
      },
      select: {
        id: true,
        code: true,
        type: true,
        value: true,
        maxDiscount: true,
        usageLimit: true,
        usedCount: true,
        startsAt: true,
        endsAt: true,
        createdAt: true,
      },
      orderBy: [{ createdAt: "desc" }],
      take: 10,
    }),
  ]);
  const activePromotionCoupon =
    (activePromotionCouponRows || []).find((coupon) => {
      const usageLimit =
        coupon?.usageLimit === null || coupon?.usageLimit === undefined
          ? null
          : Number(coupon.usageLimit);
      if (usageLimit === null) return true;
      return Number(coupon?.usedCount || 0) < usageLimit;
    }) || null;
  const totalEnrollees = await prisma.enrollment.count({
    where: {
      courseId: course.id,
      status: { in: ["ACTIVE", "COMPLETED"] },
    },
  });
  const totalReviews = course.reviews.length;
  const averageRating = totalReviews
    ? Number(
        (
          course.reviews.reduce((sum, review) => sum + Number(review?.rating || 0), 0) /
          totalReviews
        ).toFixed(1),
      )
    : 0;
  const isBestseller =
    totalEnrollees >= 100 && totalReviews >= 20 && averageRating >= 4.5;

  const goals = await readCourseGoals(course.id);
  const coverImage = mapLegacyMedia(
    pickLatestMediaByTypes(course.media, COVER_MEDIA_TYPES),
  );
  const promoVideo = mapLegacyMedia(
    pickLatestMediaByTypes(course.media, PROMO_MEDIA_TYPES),
  );
  const topicMap = new Map();
  for (const section of course.sections) {
    for (const lesson of section.lessons) {
      if (lesson?.topic?.id && !topicMap.has(lesson.topic.id)) {
        topicMap.set(lesson.topic.id, {
          id: lesson.topic.id,
          slug: lesson.topic.slug,
          title: lesson.topic.name || "",
        });
      }
      for (const lessonTopic of lesson.lessonTopics || []) {
        const row = lessonTopic?.topic;
        if (row?.id && !topicMap.has(row.id)) {
          topicMap.set(row.id, {
            id: row.id,
            slug: row.slug,
            title: row.name || "",
          });
        }
      }
    }
  }

  return {
    id: course.id,
    slug: course.slug,
    title: course.title,
    subtitle: course.subtitle,
    description: course.description,
    language: course.language || "English",
    updated_at: course.updatedAt,
    categories: course.category
      ? [{ id: course.category.id, slug: course.category.slug, title: course.category.name || course.category.title }]
      : [],
    topics: Array.from(topicMap.values()).sort((a, b) =>
      String(a.title || "").localeCompare(String(b.title || "")),
    ),
    sections: course.sections.map((section) => ({
      id: section.id,
      title: section.title,
      curriculums: section.lessons.map((lesson) => ({
        id: lesson.id,
        uuid: lesson.id,
        title: lesson.title,
        curriculum_resource_type:
          lesson.type === "QUIZ"
            ? "quiz"
            : lesson.type === "CODING_EXERCISE"
              ? "coding_exercise"
              : lesson.videoUrl || lesson.type === "VIDEO"
                ? "video"
                : lesson.assignmentText || lesson.type === "RESOURCE"
                  ? "article"
                  : "null",
        topic_id: lesson.topicId || null,
        estimated_duration: estimateLessonDurationSeconds(lesson),
        curriculum_description: lesson.description || "",
        is_public_preview: Boolean(lesson.isPreview),
        preview_asset: lesson.isPreview
          ? lesson.type === "QUIZ"
            ? {
                questions: Array.isArray(safeParseJson(lesson.quizQuestions))
                  ? safeParseJson(lesson.quizQuestions)
                  : safeParseJson(lesson.quizQuestions)?.questions || [],
              }
            : lesson.type === "CODING_EXERCISE"
              ? {
                  instructions: lesson.codingInstructions || "",
                }
              : lesson.videoUrl || lesson.type === "VIDEO"
                ? {
                    path: `/stream.php?id=${encodeURIComponent(lesson.id)}`,
                  }
                : lesson.assignmentText || lesson.type === "RESOURCE"
                  ? {
                      content: lesson.assignmentText || lesson.description || "",
                    }
                  : null
          : null,
      })),
    })),
    resources_count: {
      section_count: course.sections.length,
      curriculum_count: course.sections.reduce((acc, section) => acc + section.lessons.length, 0),
      article_count: course.sections.reduce(
        (acc, section) => acc + section.lessons.filter((lesson) => lesson.type === "RESOURCE").length,
        0,
      ),
    },
    author: {
      data: {
        id: course.educator.id,
        username: course.educator.username,
        firstname: course.educator.firstName || "",
        lastname: course.educator.lastName || "",
        user_picture: null,
      },
    },
    instructional_level: course.level
      ? {
          id: course.level.id,
          title: course.level.title,
        }
      : { id: null, title: "All Levels" },
    price_tier: course.priceTier
      ? {
          id: course.priceTier.id,
          title: course.priceTier.title,
          price: String(course.priceTier.price),
        }
      : null,
    promo_video: promoVideo,
    cover_image: coverImage,
    goals,
    workflow_status: course.workflowStatus,
    stats: {
      average_rating: averageRating,
      total_reviews: totalReviews,
      total_enrollees: totalEnrollees,
      is_bestseller: isBestseller,
    },
    promotion_coupon: activePromotionCoupon
      ? {
          id: activePromotionCoupon.id,
          code: activePromotionCoupon.code,
          type: activePromotionCoupon.type,
          value: Number(activePromotionCoupon.value || 0),
          max_discount:
            activePromotionCoupon.maxDiscount === null ||
            activePromotionCoupon.maxDiscount === undefined
              ? null
              : Number(activePromotionCoupon.maxDiscount),
          usage_limit:
            activePromotionCoupon.usageLimit === null ||
            activePromotionCoupon.usageLimit === undefined
              ? null
              : Number(activePromotionCoupon.usageLimit),
          used_count: Number(activePromotionCoupon.usedCount || 0),
          starts_at: activePromotionCoupon.startsAt,
          ends_at: activePromotionCoupon.endsAt,
        }
      : null,
    is_enrolled: Boolean(isEnrolled),
    is_in_cart: Boolean(isInCart),
    is_in_wishlist: Boolean(isInWishlist),
  };
}

export async function getCourseForLearner(userId, slug) {
  const enrollment = await prisma.enrollment.findFirst({
    where: {
      userId,
      status: "ACTIVE",
      course: {
        OR: [{ slug }, { id: slug }],
        deletedAt: null,
      },
    },
    include: {
      course: {
        include: {
          educator: {
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
              headline: true,
              biography: true,
            },
          },
          level: {
            select: {
              id: true,
              title: true,
            },
          },
          sections: {
            orderBy: { position: "asc" },
            include: {
              lessons: {
                orderBy: { position: "asc" },
                include: {
                  progress: {
                    where: { userId },
                    orderBy: { updatedAt: "desc" },
                    select: {
                      isCompleted: true,
                      progressPct: true,
                    },
                    take: 1,
                  },
                },
              },
            },
          },
        },
      },
    },
  });

  if (!enrollment) {
    throw new ApiError(404, "Enrollment not found");
  }

  const goals = await readCourseGoals(enrollment.course.id);

  return {
    course: {
      id: enrollment.course.id,
      uuid: enrollment.course.id,
      slug: enrollment.course.slug,
      title: enrollment.course.title,
      subtitle: enrollment.course.subtitle,
      description: enrollment.course.description,
      instructional_level: enrollment.course.level
        ? {
            id: enrollment.course.level.id,
            title: enrollment.course.level.title,
          }
        : { id: null, title: "All Levels" },
      author: {
        data: {
          id: enrollment.course.educator?.id || null,
          username: enrollment.course.educator?.username || null,
          firstname: enrollment.course.educator?.firstName || "",
          lastname: enrollment.course.educator?.lastName || "",
          headline: enrollment.course.educator?.headline || "",
          biography: enrollment.course.educator?.biography || "",
          user_picture: null,
        },
      },
      goals,
      sections: enrollment.course.sections.map((section) => ({
        id: section.id,
        uuid: section.id,
        title: section.title,
        curriculums: section.lessons.map((lesson) => {
          const lessonProgress = lesson.progress?.[0] || null;
          const isTaken = Boolean(lessonProgress?.isCompleted);
          const parsedQuizQuestions = safeParseJson(lesson.quizQuestions);
          const parsedStarterCode = safeParseJson(lesson.codingStarterCode);

          return {
            id: lesson.id,
            uuid: lesson.id,
            title: lesson.title,
            curriculum_resource_type:
                lesson.type === "QUIZ"
                  ? "quiz"
                  : lesson.type === "CODING_EXERCISE"
                    ? "coding_exercise"
                    : lesson.videoUrl || lesson.type === "VIDEO"
                ? "video"
                : lesson.assignmentText
                  ? "article"
                  : "null",
            topic_id: lesson.topicId || null,
            curriculum_description: lesson.description || "",
            estimated_duration: estimateLessonDurationSeconds(lesson),
            asset:
              lesson.type === "QUIZ"
                ? {
                    questions: Array.isArray(parsedQuizQuestions)
                      ? parsedQuizQuestions
                      : parsedQuizQuestions?.questions || [],
                  }
                : lesson.type === "CODING_EXERCISE"
                  ? {
                      instructions: lesson.codingInstructions || "",
                      starter_code:
                        parsedStarterCode?.starter_code || parsedStarterCode || {},
                      expected_output: parsedStarterCode?.expected_output || {},
                      languages: parsedStarterCode?.languages || [],
                      test_cases_visible: normalizeVisibleCodingTests(parsedStarterCode),
                      step_challenges:
                        parsedStarterCode?.step_challenges &&
                        typeof parsedStarterCode.step_challenges === "object"
                          ? parsedStarterCode.step_challenges
                          : {},
                      checklist: normalizeStringArray(parsedStarterCode?.checklist),
                      hints: normalizeStringArray(parsedStarterCode?.hints),
                    }
                : lesson.videoUrl || lesson.type === "VIDEO"
                ? {
                    id: lesson.id,
                    path: `/stream.php?id=${encodeURIComponent(lesson.id)}`,
                  }
                : lesson.assignmentText
                  ? { id: lesson.id, content: lesson.assignmentText }
                  : null,
            is_taken: isTaken,
            completed: isTaken,
            progress_pct: Number(lessonProgress?.progressPct || 0),
          };
        }),
      })),
    },
  };
}

function clipText(value, maxLength) {
  const normalized = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return "";
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 1)}…`
    : normalized;
}

function buildCourseAssistantSuggestedTopics(course) {
  const topics = [];
  const seen = new Set();

  const pushUnique = (text) => {
    const normalized = clipText(text, 120);
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    topics.push(normalized);
  };

  for (const section of course?.sections || []) {
    pushUnique(`Section: ${section.title}`);
    for (const lesson of (section.lessons || []).slice(0, 6)) {
      pushUnique(`Lesson: ${lesson.title}`);
    }
  }

  return topics.slice(0, 14);
}

function buildCourseAssistantContext(course) {
  return (course?.sections || []).slice(0, 14).map((section) => ({
    section_title: clipText(section?.title, 140),
    section_description: clipText(section?.description, 260),
    lessons: (section?.lessons || []).slice(0, 16).map((lesson) => ({
      lesson_id: lesson.id,
      lesson_title: clipText(lesson?.title, 160),
      lesson_type: lesson?.type || "RESOURCE",
      lesson_description: clipText(lesson?.description, 300),
      assignment_text: clipText(lesson?.assignmentText, 240),
      coding_instructions: clipText(lesson?.codingInstructions, 240),
      has_quiz: Boolean(
        Array.isArray(safeParseJson(lesson?.quizQuestions)) ||
          safeParseJson(lesson?.quizQuestions)?.questions,
      ),
    })),
  }));
}

function tokenizeScopeText(value) {
  const stopWords = new Set([
    "the",
    "and",
    "for",
    "with",
    "that",
    "this",
    "from",
    "about",
    "into",
    "your",
    "you",
    "are",
    "was",
    "were",
    "can",
    "could",
    "would",
    "should",
    "what",
    "when",
    "where",
    "which",
    "have",
    "has",
    "had",
    "how",
    "why",
    "its",
    "it's",
    "our",
    "their",
    "them",
    "they",
    "his",
    "her",
    "she",
    "him",
    "who",
    "will",
    "just",
    "also",
    "than",
    "then",
    "there",
    "here",
    "very",
    "more",
    "most",
    "some",
    "any",
    "all",
    "not",
    "too",
    "a",
    "an",
    "of",
    "to",
    "in",
    "on",
    "at",
    "is",
    "be",
    "or",
    "as",
    "by",
    "it",
    "if",
    "do",
    "did",
    "does",
    "we",
    "i",
    "me",
    "my",
  ]);

  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !stopWords.has(token));
}

function buildCourseScopeTokenSet(course) {
  const corpus = [
    course?.title,
    course?.subtitle,
    course?.description,
    ...(course?.sections || []).flatMap((section) => [
      section?.title,
      section?.description,
      ...(section?.lessons || []).flatMap((lesson) => [
        lesson?.title,
        lesson?.description,
        lesson?.assignmentText,
        lesson?.codingInstructions,
      ]),
    ]),
  ]
    .map((value) => String(value || ""))
    .join(" ");

  return new Set(tokenizeScopeText(corpus));
}

function isCourseRelatedQuestion({ message, course, recentMessages, selectedLecture }) {
  const normalizedMessage = String(message || "").trim();
  if (!normalizedMessage) return false;

  const broadCourseIntent =
    /(course|lesson|section|curriculum|quiz|assignment|exercise|module|chapter|topic|lecture|learn|learning|syllabus|project|instructor|video)/i.test(
      normalizedMessage,
    );
  if (broadCourseIntent) return true;

  if (
    selectedLecture &&
    /(this|that|it|explain again|summarize|next step|what next|review)/i.test(
      normalizedMessage.toLowerCase(),
    )
  ) {
    return true;
  }

  const messageTokens = tokenizeScopeText(normalizedMessage);
  if (!messageTokens.length) return false;

  const scopeTokens = buildCourseScopeTokenSet(course);
  let overlap = 0;
  for (const token of messageTokens) {
    if (scopeTokens.has(token)) overlap += 1;
    if (overlap >= 1) return true;
  }

  if (
    Array.isArray(recentMessages) &&
    recentMessages.length > 0 &&
    messageTokens.length <= 6 &&
    /(again|clarify|example|why|how|step|detail)/i.test(normalizedMessage)
  ) {
    return true;
  }

  return false;
}

export async function askCourseLearningAssistant(userId, slug, payload = {}) {
  const enrollment = await prisma.enrollment.findFirst({
    where: {
      userId,
      status: { in: ["ACTIVE", "COMPLETED"] },
      course: {
        OR: [{ slug }, { id: slug }],
        deletedAt: null,
      },
    },
    include: {
      course: {
        select: {
          id: true,
          slug: true,
          title: true,
          subtitle: true,
          description: true,
          sections: {
            orderBy: { position: "asc" },
            select: {
              id: true,
              title: true,
              description: true,
              lessons: {
                orderBy: { position: "asc" },
                select: {
                  id: true,
                  title: true,
                  description: true,
                  type: true,
                  assignmentText: true,
                  codingInstructions: true,
                  quizQuestions: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (!enrollment?.course) {
    throw new ApiError(404, "Enrollment not found");
  }
  if (!env.aiKey) {
    throw new ApiError(
      500,
      "AI key is not configured. Set AI_KEY in the backend environment.",
    );
  }

  const userMessage = clipText(payload?.message, 4000);
  if (userMessage.length < 2) {
    throw new ApiError(400, "Message is required");
  }

  const selectedLectureId = String(payload?.lecture_id || "").trim();
  const selectedLecture = selectedLectureId
    ? enrollment.course.sections
        .flatMap((section) => section.lessons || [])
        .find((lesson) => lesson.id === selectedLectureId) || null
    : null;

  const recentMessages = Array.isArray(payload?.messages)
    ? payload.messages
        .slice(-10)
        .map((message) => ({
          role: message?.role === "assistant" ? "assistant" : "user",
          content: clipText(message?.content, 1200),
        }))
        .filter((message) => message.content.length > 0)
    : [];

  const isInScope = isCourseRelatedQuestion({
    message: userMessage,
    course: enrollment.course,
    recentMessages,
    selectedLecture,
  });
  if (!isInScope) {
    return {
      reply:
        "I can only help with questions related to this course. Ask me about the current lesson, section topics, quizzes, assignments, or concepts covered in this course.",
      suggested_topics: buildCourseAssistantSuggestedTopics(enrollment.course),
    };
  }

  const systemPrompt =
    "You are Upskill Course Assistant for one enrolled course. " +
    "You must ONLY answer questions directly related to the given course context. " +
    "If question is outside scope, do not answer it; return in_scope=false. " +
    "Return ONLY valid JSON with this schema: {\"in_scope\":boolean,\"answer_markdown\":string}. " +
    "Use concise markdown formatting (short paragraphs, bullets, numbered steps when relevant).";

  let aiResponse;
  try {
    aiResponse = await axios.post(
      `${env.deepseekBaseUrl.replace(/\/+$/g, "")}/chat/completions`,
      {
        model: env.deepseekModel,
        temperature: 0.4,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "system",
            content: JSON.stringify({
              course: {
                id: enrollment.course.id,
                slug: enrollment.course.slug,
                title: enrollment.course.title,
                subtitle: clipText(enrollment.course.subtitle, 220),
                description: clipText(enrollment.course.description, 800),
              },
              selected_lesson: selectedLecture
                ? {
                    id: selectedLecture.id,
                    title: selectedLecture.title,
                    type: selectedLecture.type,
                    description: clipText(selectedLecture.description, 400),
                  }
                : null,
              curriculum_outline: buildCourseAssistantContext(enrollment.course),
            }),
          },
          ...recentMessages,
          { role: "user", content: userMessage },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${env.aiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 60000,
      },
    );
  } catch (_error) {
    throw new ApiError(
      502,
      "AI assistant is unavailable right now. Please try again.",
    );
  }

  const rawReply = clipText(aiResponse?.data?.choices?.[0]?.message?.content, 8000);
  const parsedReply = readJsonFromAiContent(rawReply) || {};
  const hasInScopeFlag =
    typeof parsedReply?.in_scope === "boolean" ||
    parsedReply?.in_scope === "true" ||
    parsedReply?.in_scope === "false";
  const parsedInScope =
    parsedReply?.in_scope === true || parsedReply?.in_scope === "true";
  const parsedAnswer = clipText(parsedReply?.answer_markdown, 6000);
  const fallbackReply = clipText(rawReply, 6000);

  const reply = hasInScopeFlag
    ? parsedInScope
      ? parsedAnswer || fallbackReply
      : "I can only help with this course’s content. Ask about lessons, sections, quizzes, assignments, or concepts included in this course."
    : fallbackReply;
  if (!reply) {
    throw new ApiError(502, "AI assistant returned an empty response");
  }

  return {
    reply,
    suggested_topics: buildCourseAssistantSuggestedTopics(enrollment.course),
  };
}

function normalizeAISuggestedLessonType(input) {
  const normalized = String(input || "RESOURCE")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "_");
  if (normalized === "ARTICLE") return "RESOURCE";
  if (["VIDEO", "QUIZ", "CODING_EXERCISE", "RESOURCE", "ASSIGNMENT"].includes(normalized)) {
    return normalized;
  }
  return "RESOURCE";
}

function trimForDb(value, maxLength) {
  const normalized = String(value || "").trim();
  if (!normalized) return "";
  return normalized.slice(0, maxLength);
}

function ensureEditableWorkflowStatus(workflowStatus) {
  const normalized = String(workflowStatus || "").toUpperCase();
  if (!["DRAFT", "REJECTED", "PUBLISHED"].includes(normalized)) {
    throw new ApiError(
      400,
      "Only draft, rejected, or published courses can be updated with AI",
    );
  }
}

export async function updateCourseWithAI(userId, courseId, payload = {}) {
  const target = String(payload?.target || "auto")
    .trim()
    .toLowerCase();
  const prompt = trimForDb(payload?.prompt, 4000);
  const sectionId = String(payload?.section_id || "").trim();
  const curriculumId = String(payload?.curriculum_id || "").trim();

  if (!["auto", "course_basics", "section", "curriculum", "new_section"].includes(target)) {
    throw new ApiError(400, "Invalid AI update target");
  }
  if (prompt.length < 20) {
    throw new ApiError(400, "Prompt must be at least 20 characters");
  }
  if (!env.aiKey) {
    throw new ApiError(
      500,
      "AI key is not configured. Set AI_KEY in the backend environment.",
    );
  }

  const course = await prisma.course.findFirst({
    where: { id: courseId, educatorId: userId, deletedAt: null },
    include: {
      category: {
        select: {
          id: true,
          name: true,
          slug: true,
          parent: {
            select: {
              id: true,
              name: true,
              slug: true,
            },
          },
        },
      },
      sections: {
        orderBy: { position: "asc" },
        include: {
          lessons: {
            orderBy: { position: "asc" },
            select: {
              id: true,
              title: true,
              description: true,
              type: true,
              assignmentText: true,
              codingInstructions: true,
            },
          },
        },
      },
    },
  });
  if (!course) {
    throw new ApiError(404, "Course not found");
  }
  ensureEditableWorkflowStatus(course.workflowStatus);
  const courseGoals = await readCourseGoals(course.id);
  const updateTopicCatalog = await loadAICourseTopicCatalog(course.categoryId);
  const supportsLessonTopics = Boolean(prisma.lessonTopic);
  const aiUpdateFocusTerms = buildAIDraftFocusTerms(
    `${course.title} ${course.description || ""} ${prompt || ""}`,
  );
  const usedSectionTitles = new Set(
    (course.sections || [])
      .map((section) => String(section?.title || "").trim().toLowerCase())
      .filter(Boolean),
  );
  const usedLessonTitlesBySectionId = new Map();
  for (const section of course.sections || []) {
    usedLessonTitlesBySectionId.set(
      section.id,
      new Set(
        (section.lessons || [])
          .map((lesson) => String(lesson?.title || "").trim().toLowerCase())
          .filter(Boolean),
      ),
    );
  }

  const selectedSection = sectionId
    ? course.sections.find((section) => section.id === sectionId) || null
    : null;
  const selectedLesson = curriculumId
    ? course.sections
        .flatMap((section) => section.lessons || [])
        .find((lesson) => lesson.id === curriculumId) || null
    : null;

  if (target === "section" && !selectedSection) {
    throw new ApiError(400, "Select a valid section for AI update");
  }
  if (target === "curriculum" && !selectedLesson) {
    throw new ApiError(400, "Select a valid curriculum item for AI update");
  }

  const findSectionByRef = (sectionRef = "") => {
    const normalizedRef = String(sectionRef || "").trim();
    if (!normalizedRef) return null;
    const byId = course.sections.find((section) => section.id === normalizedRef);
    if (byId) return byId;

    const lowered = normalizedRef.toLowerCase();
    return (
      course.sections.find((section) =>
        String(section.title || "").toLowerCase().includes(lowered),
      ) || null
    );
  };

  const findLessonByRef = (lessonRef = "", sectionRef = "") => {
    const normalizedLessonRef = String(lessonRef || "").trim();
    if (!normalizedLessonRef) return null;

    const sectionScoped = findSectionByRef(sectionRef);
    const candidates = sectionScoped
      ? sectionScoped.lessons || []
      : course.sections.flatMap((section) => section.lessons || []);

    const byId = candidates.find((lesson) => lesson.id === normalizedLessonRef);
    if (byId) return byId;

    const lowered = normalizedLessonRef.toLowerCase();
    return (
      candidates.find((lesson) =>
        String(lesson.title || "").toLowerCase().includes(lowered),
      ) || null
    );
  };

  const createSectionWithLessons = async (input = {}) => {
    const aiFocusTerms = aiUpdateFocusTerms;
    const normalizedSectionTitle = trimForDb(input?.title, 160);
    let section = null;
    let createAttempt = 0;
    while (!section && createAttempt < 5) {
      createAttempt += 1;
      const lastSection = await prisma.courseSection.findFirst({
        where: { courseId: course.id },
        orderBy: { position: "desc" },
        select: { position: true },
      });
      const nextSectionPosition = Number(lastSection?.position || 0) + 1;
      const computedSectionTitle =
        !normalizedSectionTitle || looksLikeGenericSectionTitle(normalizedSectionTitle)
          ? suggestSectionTitleFromTerms(
              Math.max(0, nextSectionPosition - 1),
              buildAIDraftFocusTerms(
                `${input?.description || ""} ${input?.title || ""} ${course.title} ${prompt}`,
              ).length
                ? buildAIDraftFocusTerms(
                    `${input?.description || ""} ${input?.title || ""} ${course.title} ${prompt}`,
                  )
                : aiFocusTerms,
              course.title,
            )
          : normalizedSectionTitle;
      const uniqueSectionTitle = ensureUniqueTitle(
        computedSectionTitle,
        usedSectionTitles,
        160,
        "Course Topic Deep Dive",
      );

      try {
        section = await prisma.courseSection.create({
          data: {
            courseId: course.id,
            title: uniqueSectionTitle,
            description: resolveSectionObjectiveText(
              input?.description || "",
              uniqueSectionTitle,
              course.title,
            ),
            position: nextSectionPosition,
          },
        });
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === "P2002"
        ) {
          continue;
        }
        throw error;
      }
    }

    if (!section) {
      throw new ApiError(
        409,
        "Unable to allocate a section position. Please try again.",
      );
    }

    const lessons = Array.isArray(input?.lessons) ? input.lessons.slice(0, 40) : [];
    const fallbackLessons =
      lessons.length > 0
        ? lessons
        : [
            {
              title: suggestLessonTitleFromTerms(section.title, 0, aiFocusTerms),
              description: "Expand this lesson with examples and exercises.",
              type: "RESOURCE",
              estimated_minutes: 10,
            },
          ];
    const usedLessonTitles = new Set();
    usedLessonTitlesBySectionId.set(section.id, usedLessonTitles);

    for (let lessonIndex = 0; lessonIndex < fallbackLessons.length; lessonIndex += 1) {
      const lesson = fallbackLessons[lessonIndex] || {};
      const type = normalizeAISuggestedLessonType(lesson?.type);
      const lessonDescription = resolveCurriculumDescriptionText(
        lesson?.description || "",
        lesson?.title || "",
        section.title,
        course.title,
      );
      const bestTopic = pickBestTopicForAIGeneratedLesson(updateTopicCatalog, {
        topicHint: lesson?.topic_hint || lesson?.topic || "",
        title: lesson?.title || "",
        description: lessonDescription,
        sectionTitle: section.title,
        courseTitle: course.title,
        courseDescription: course.description || "",
      });
      const estimatedMinutes = Number(lesson?.estimated_minutes || 8);
      const durationInSeconds = Number.isFinite(estimatedMinutes)
        ? Math.max(60, Math.min(90 * 60, Math.round(estimatedMinutes * 60)))
        : 8 * 60;
      const lessonTerms = buildAIDraftFocusTerms(
        `${lessonDescription} ${lesson?.title || ""} ${section.title} ${course.title} ${prompt}`,
      );
      const lessonCandidate =
        looksLikeGenericLessonTitle(lesson?.title)
          ? suggestLessonTitleFromTerms(
              section.title,
              lessonIndex,
              lessonTerms.length ? lessonTerms : aiFocusTerms,
            )
          : lesson?.title;
      const uniqueLessonTitle = ensureUniqueTitle(
        lessonCandidate,
        usedLessonTitles,
        180,
        `Applied ${section.title} Topic`,
      );
      await prisma.lesson.create({
        data: {
          courseId: course.id,
          sectionId: section.id,
          topicId: bestTopic?.id || null,
          ...(supportsLessonTopics && bestTopic?.id
            ? {
                lessonTopics: {
                  create: [{ topicId: bestTopic.id }],
                },
              }
            : {}),
          title: uniqueLessonTitle,
          description: lessonDescription || null,
          type,
          assignmentText:
            type === "RESOURCE" || type === "ASSIGNMENT"
              ? lessonDescription || null
              : null,
          position: lessonIndex + 1,
          durationInSeconds,
          isPreview: false,
        },
      });
    }
  };

  const normalizeNullableAiMessage = (nextValue, fallbackValue) => {
    if (nextValue === undefined) return fallbackValue ?? null;
    const normalized = trimForDb(nextValue, 5000);
    return normalized ? normalized : null;
  };

  const normalizeOperationAction = (rawAction) => {
    const action = String(rawAction || "")
      .trim()
      .toLowerCase()
      .replace(/-/g, "_");
    if (!action) return "";

    if (/(delete|remove).*(curriculum|lesson|lecture)/.test(action)) {
      return "delete_curriculum";
    }
    if (/(delete|remove).*(section|module|chapter)/.test(action)) {
      return "delete_section";
    }
    if (/(update).*(curriculum|lesson|lecture)/.test(action)) {
      return "update_curriculum";
    }
    if (/(update).*(section|module|chapter)/.test(action)) {
      return "update_section";
    }
    return action;
  };

  const schemaByTarget = {
    auto:
      '{"operations":[{"action":"update_course_basics|update_section|update_curriculum|add_section|update_all_sections|update_all_curriculums|delete_section|delete_curriculum|delete_all_curriculums","apply_to_all":"optional boolean","section_id":"optional","section_title":"optional","curriculum_id":"optional","curriculum_title":"optional","title":"optional","subtitle":"optional","description":"optional","language":"optional","welcome_message":"optional","congratulations_message":"optional","topic_hint":"optional for curriculum","type":"optional for curriculum","lessons":"optional for add_section"}]}',
    course_basics:
      '{"title":"string<=60","subtitle":"string<=180","description":"string<=8000","language":"string<=100","welcome_message":"string<=5000 optional","congratulations_message":"string<=5000 optional"}',
    section: '{"title":"string<=160","description":"string<=5000"}',
    curriculum:
      '{"title":"string<=180","description":"string<=8000","topic_hint":"optional string","type":"VIDEO|QUIZ|CODING_EXERCISE|RESOURCE|ASSIGNMENT"}',
    new_section:
      '{"title":"string<=160","description":"string<=5000","lessons":[{"title":"string<=180","description":"string<=8000","type":"VIDEO|QUIZ|CODING_EXERCISE|RESOURCE|ASSIGNMENT","estimated_minutes":"number"}]}',
  };

  const systemPrompt =
    "You are an expert instructional designer for course editing. " +
    "Return ONLY valid JSON (no markdown) matching the requested schema. " +
    "Keep updates practical and aligned to existing course context. " +
    "Always ground generated section/curriculum content in the course title, description, category, intended learners, requirements, and learning goals. " +
    "Section and curriculum titles must be descriptive and specific; avoid generic numbering-only titles. " +
    "If the user instruction is specific, follow it, but keep all additions/updates clearly related to this course scope. " +
    "For specific section/curriculum updates, include matching section_id/curriculum_id from context whenever possible. " +
    "Use update_all_sections or update_all_curriculums when instruction asks for all. " +
    "Use delete_section, delete_curriculum, or delete_all_curriculums for delete/remove instructions. " +
    "Do not include fields outside the schema.";

  let aiResponse;
  try {
    aiResponse = await axios.post(
      `${env.deepseekBaseUrl.replace(/\/+$/g, "")}/chat/completions`,
      {
        model: env.deepseekModel,
        temperature: 0.55,
        messages: [
          { role: "system", content: systemPrompt },
          {
            role: "system",
            content: JSON.stringify({
              target,
              schema: schemaByTarget[target],
              selected_section: selectedSection
                ? {
                    id: selectedSection.id,
                    title: selectedSection.title,
                    description: clipText(selectedSection.description, 400),
                  }
                : null,
              selected_curriculum: selectedLesson
                ? {
                    id: selectedLesson.id,
                    title: selectedLesson.title,
                    description: clipText(selectedLesson.description, 500),
                    type: selectedLesson.type,
                  }
                : null,
              course: {
                id: course.id,
                title: course.title,
                subtitle: clipText(course.subtitle, 240),
                description: clipText(course.description, 1000),
                language: clipText(course.language, 100),
                category: course.category
                  ? {
                      id: course.category.id,
                      name: course.category.name,
                      slug: course.category.slug,
                      parent: course.category.parent
                        ? {
                            id: course.category.parent.id,
                            name: course.category.parent.name,
                            slug: course.category.parent.slug,
                          }
                        : null,
                    }
                  : null,
                welcome_message: clipText(course.welcomeMessage, 500),
                congratulations_message: clipText(course.congratulationsMessage, 500),
                goals: courseGoals,
                intended_learners: Array.isArray(courseGoals?.who_should_attend_data)
                  ? courseGoals.who_should_attend_data
                  : [],
                requirements: Array.isArray(courseGoals?.requirements_data)
                  ? courseGoals.requirements_data
                  : [],
                learning_outcomes: Array.isArray(courseGoals?.what_you_will_learn_data)
                  ? courseGoals.what_you_will_learn_data
                  : [],
              },
              current_outline: course.sections.slice(0, 16).map((section) => ({
                id: section.id,
                title: clipText(section.title, 120),
                description: clipText(section.description, 400),
                lessons: (section.lessons || []).slice(0, 20).map((lesson) => ({
                  id: lesson.id,
                  title: clipText(lesson.title, 140),
                  type: lesson.type,
                  description: clipText(lesson.description, 500),
                  assignment_text: clipText(lesson.assignmentText, 500),
                  coding_instructions: clipText(lesson.codingInstructions, 500),
                })),
              })),
            }),
          },
          {
            role: "user",
            content: `Update target: ${target}\nInstruction: ${prompt}`,
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${env.aiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 60000,
      },
    );
  } catch (_error) {
    throw new ApiError(502, "AI update is unavailable right now. Please try again.");
  }

  const raw = aiResponse?.data?.choices?.[0]?.message?.content || "";
  const parsed = readJsonFromAiContent(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new ApiError(502, "AI returned an invalid update response");
  }

  if (target === "auto") {
    const operations = Array.isArray(parsed?.operations) ? parsed.operations : [];
    if (!operations.length) {
      throw new ApiError(
        400,
        "AI could not determine an update action. Please be more specific in the instruction.",
      );
    }
    let appliedChanges = 0;
    const wantsAllSections = /(all sections|every section|all the sections)/i.test(prompt);
    const wantsAllCurriculums = /(all curriculums|all curriculum|every curriculum|all lessons|every lesson|all lectures|every lecture)/i.test(
      prompt,
    );
    const wantsDelete = /(delete|remove)/i.test(prompt);
    const wantsRetitle = /(retitle|rename|title|meaningful title|improve titles|better titles)/i.test(
      prompt,
    );

    const asBoolean = (value) =>
      value === true || String(value || "").trim().toLowerCase() === "true";
    const sectionByLessonId = new Map();
    for (const section of course.sections || []) {
      for (const lesson of section.lessons || []) {
        sectionByLessonId.set(lesson.id, section);
      }
    }

    const applyTopicForLesson = async (lessonId, context = {}) => {
      const bestTopic = pickBestTopicForAIGeneratedLesson(updateTopicCatalog, {
        topicHint: context?.topic_hint || context?.topic || "",
        title: context?.title || "",
        description: context?.description || "",
        sectionTitle: context?.sectionTitle || "",
        courseTitle: course.title,
        courseDescription: course.description || "",
      });
      if (!bestTopic?.id) return null;

      await prisma.lesson.update({
        where: { id: lessonId },
        data: { topicId: bestTopic.id },
      });
      if (supportsLessonTopics && prisma.lessonTopic) {
        await prisma.lessonTopic.deleteMany({
          where: { lessonId },
        });
        await prisma.lessonTopic.create({
          data: {
            lessonId,
            topicId: bestTopic.id,
          },
        });
      }
      return bestTopic.id;
    };

    for (const operation of operations.slice(0, 12)) {
      const action = normalizeOperationAction(operation?.action);
      const applyToAll = asBoolean(operation?.apply_to_all);

      if (action === "update_course_basics") {
        await prisma.course.update({
          where: { id: course.id },
          data: {
            title: trimForDb(operation?.title || course.title, 60) || course.title,
            subtitle: trimForDb(operation?.subtitle || course.subtitle, 180) || null,
            description:
              trimForDb(operation?.description || course.description, 8000) || null,
            language: trimForDb(
              operation?.language || course.language || "English",
              100,
            ),
            welcomeMessage: normalizeNullableAiMessage(
              operation?.welcome_message ?? operation?.welcomeMessage,
              course.welcomeMessage,
            ),
            congratulationsMessage: normalizeNullableAiMessage(
              operation?.congratulations_message ?? operation?.congratulationsMessage,
              course.congratulationsMessage,
            ),
          },
        });
        appliedChanges += 1;
        continue;
      }

      if (
        action === "update_section" ||
        action === "update_sections" ||
        action === "update_all_sections"
      ) {
        const shouldApplyAll =
          action === "update_all_sections" || applyToAll || wantsAllSections;
        if (shouldApplyAll) {
          for (let sectionIndex = 0; sectionIndex < (course.sections || []).length; sectionIndex += 1) {
            const section = course.sections[sectionIndex];
            const nextDescription =
              resolveSectionObjectiveText(
                operation?.description || section.description,
                section.title,
                course.title,
              );
            const operationTitle = trimForDb(operation?.title, 160);
            const sectionTerms = buildAIDraftFocusTerms(
              `${nextDescription} ${section.title} ${course.title} ${prompt}`,
            );
            const generatedTitle = suggestSectionTitleFromTerms(
              sectionIndex,
              sectionTerms.length ? sectionTerms : aiUpdateFocusTerms,
              course.title,
            );
            const nextTitleCandidate =
              operationTitle && !looksLikeGenericSectionTitle(operationTitle)
                ? applyToAll
                  ? `${operationTitle} - ${toTitleCase(aiUpdateFocusTerms[sectionIndex % Math.max(1, aiUpdateFocusTerms.length)] || "Applied")}`.slice(
                      0,
                      160,
                    )
                  : operationTitle
                : looksLikeGenericSectionTitle(section.title) || wantsRetitle
                  ? generatedTitle
                  : section.title;
            const nextTitle = ensureUniqueTitle(
              nextTitleCandidate,
              usedSectionTitles,
              160,
              `Course Topic ${sectionIndex + 1}`,
            );
            await prisma.courseSection.update({
              where: { id: section.id },
              data: {
                title: nextTitle,
                description: nextDescription,
              },
            });
            appliedChanges += 1;
          }
          continue;
        }

        const section =
          findSectionByRef(operation?.section_id) ||
          findSectionByRef(operation?.section_title);
        if (!section) continue;
        const operationTitle = trimForDb(operation?.title, 160);
        const sectionTerms = buildAIDraftFocusTerms(
          `${operation?.description || ""} ${section.description || ""} ${section.title} ${course.title} ${prompt}`,
        );
        const nextSectionTitleCandidate =
          operationTitle && !looksLikeGenericSectionTitle(operationTitle)
            ? operationTitle
            : looksLikeGenericSectionTitle(section.title) || wantsRetitle
              ? suggestSectionTitleFromTerms(
                  0,
                  sectionTerms.length ? sectionTerms : aiUpdateFocusTerms,
                  course.title,
                )
              : section.title;
        const nextSectionTitle = ensureUniqueTitle(
          nextSectionTitleCandidate,
          usedSectionTitles,
          160,
          section.title || "Course Topic",
        );
        await prisma.courseSection.update({
          where: { id: section.id },
          data: {
            title: nextSectionTitle,
            description:
              resolveSectionObjectiveText(
                operation?.description || section.description,
                nextSectionTitle,
                course.title,
              ),
          },
        });
        appliedChanges += 1;
        continue;
      }

      if (
        action === "update_curriculum" ||
        action === "update_curriculums" ||
        action === "update_all_curriculums" ||
        action === "update_all_curriculum"
      ) {
        const shouldApplyAll =
          action === "update_all_curriculums" ||
          action === "update_all_curriculum" ||
          applyToAll ||
          wantsAllCurriculums;
        if (shouldApplyAll) {
          const allLessons = course.sections.flatMap((section) => section.lessons || []);
          for (let lessonIndex = 0; lessonIndex < allLessons.length; lessonIndex += 1) {
            const lesson = allLessons[lessonIndex];
            const ownerSection = sectionByLessonId.get(lesson.id);
            const usedLessonTitles =
              usedLessonTitlesBySectionId.get(ownerSection?.id) || new Set();
            if (ownerSection?.id && !usedLessonTitlesBySectionId.has(ownerSection.id)) {
              usedLessonTitlesBySectionId.set(ownerSection.id, usedLessonTitles);
            }
            const nextType = normalizeAISuggestedLessonType(
              operation?.type || lesson.type || "RESOURCE",
            );
            const operationTitle = trimForDb(operation?.title, 180);
            const lessonTerms = buildAIDraftFocusTerms(
              `${operation?.description || lesson.description || ""} ${lesson.title} ${ownerSection?.title || ""} ${course.title} ${prompt}`,
            );
            const generatedLessonTitle = suggestLessonTitleFromTerms(
              ownerSection?.title || "Course Topic",
              lessonIndex,
              lessonTerms.length ? lessonTerms : aiUpdateFocusTerms,
            );
            const nextTitleCandidate =
              operationTitle && !looksLikeGenericLessonTitle(operationTitle)
                ? applyToAll
                  ? `${operationTitle} - ${toTitleCase(aiUpdateFocusTerms[lessonIndex % Math.max(1, aiUpdateFocusTerms.length)] || "Applied")}`.slice(
                      0,
                      180,
                    )
                  : operationTitle
                : looksLikeGenericLessonTitle(lesson.title) || wantsRetitle
                  ? generatedLessonTitle
                  : lesson.title;
            const nextTitle = ensureUniqueTitle(
              nextTitleCandidate,
              usedLessonTitles,
              180,
              `Applied ${ownerSection?.title || "Course"} Topic`,
            );
            const nextDescription = resolveCurriculumDescriptionText(
              operation?.description || lesson.description,
              nextTitle,
              ownerSection?.title || "",
              course.title,
            );
            await prisma.lesson.update({
              where: { id: lesson.id },
              data: {
                title: nextTitle,
                description: nextDescription,
                type: nextType,
                assignmentText:
                  nextType === "RESOURCE" || nextType === "ASSIGNMENT"
                    ? nextDescription
                    : null,
              },
            });
            await applyTopicForLesson(lesson.id, {
              topic_hint: operation?.topic_hint || "",
              title: nextTitle,
              description: nextDescription,
              sectionTitle: ownerSection?.title || "",
            });
            appliedChanges += 1;
          }
          continue;
        }

        const lesson =
          findLessonByRef(operation?.curriculum_id, operation?.section_id) ||
          findLessonByRef(operation?.curriculum_title, operation?.section_title);
        if (!lesson) continue;

        const nextType = normalizeAISuggestedLessonType(
          operation?.type || lesson.type || "RESOURCE",
        );
        const ownerSection = sectionByLessonId.get(lesson.id);
        const usedLessonTitles =
          usedLessonTitlesBySectionId.get(ownerSection?.id) || new Set();
        if (ownerSection?.id && !usedLessonTitlesBySectionId.has(ownerSection.id)) {
          usedLessonTitlesBySectionId.set(ownerSection.id, usedLessonTitles);
        }
        const operationTitle = trimForDb(operation?.title, 180);
        const lessonTerms = buildAIDraftFocusTerms(
          `${operation?.description || lesson.description || ""} ${lesson.title} ${ownerSection?.title || ""} ${course.title} ${prompt}`,
        );
        const nextTitleCandidate =
          operationTitle && !looksLikeGenericLessonTitle(operationTitle)
            ? operationTitle
            : looksLikeGenericLessonTitle(lesson.title) || wantsRetitle
              ? suggestLessonTitleFromTerms(
                  ownerSection?.title || "Course Topic",
                  0,
                  lessonTerms.length ? lessonTerms : aiUpdateFocusTerms,
                )
              : lesson.title;
        const nextTitle = ensureUniqueTitle(
          nextTitleCandidate,
          usedLessonTitles,
          180,
          `Applied ${ownerSection?.title || "Course"} Topic`,
        );
        const nextDescription = resolveCurriculumDescriptionText(
          operation?.description || lesson.description,
          nextTitle,
          ownerSection?.title || "",
          course.title,
        );
        await prisma.lesson.update({
          where: { id: lesson.id },
          data: {
            title: nextTitle,
            description: nextDescription,
            type: nextType,
            assignmentText:
              nextType === "RESOURCE" || nextType === "ASSIGNMENT"
                ? nextDescription
                : null,
          },
        });
        await applyTopicForLesson(lesson.id, {
          topic_hint: operation?.topic_hint || "",
          title: nextTitle,
          description: nextDescription,
          sectionTitle: ownerSection?.title || "",
        });
        appliedChanges += 1;
        continue;
      }

      if (
        action === "delete_curriculum" ||
        action === "delete_curriculums" ||
        action === "delete_all_curriculums" ||
        action === "delete_all_curriculum" ||
        action === "remove_curriculum" ||
        action === "remove_curriculums"
      ) {
        const shouldApplyAll =
          action === "delete_all_curriculums" ||
          action === "delete_all_curriculum" ||
          (applyToAll && wantsDelete) ||
          (wantsDelete && wantsAllCurriculums);
        if (shouldApplyAll) {
          const deleted = await prisma.lesson.deleteMany({
            where: { courseId: course.id },
          });
          appliedChanges += Number(deleted?.count || 0);
          continue;
        }

        const lesson =
          findLessonByRef(operation?.curriculum_id, operation?.section_id) ||
          findLessonByRef(operation?.curriculum_title, operation?.section_title);
        if (!lesson) continue;
        await prisma.lesson.delete({
          where: { id: lesson.id },
        });
        appliedChanges += 1;
        continue;
      }

      if (
        action === "delete_section" ||
        action === "delete_sections" ||
        action === "remove_section" ||
        action === "remove_sections"
      ) {
        const shouldApplyAll = applyToAll && wantsDelete && wantsAllSections;
        if (shouldApplyAll) {
          const deleted = await prisma.courseSection.deleteMany({
            where: { courseId: course.id },
          });
          appliedChanges += Number(deleted?.count || 0);
          continue;
        }

        const section =
          findSectionByRef(operation?.section_id) ||
          findSectionByRef(operation?.section_title);
        if (!section) continue;
        await prisma.courseSection.delete({
          where: { id: section.id },
        });
        appliedChanges += 1;
        continue;
      }

      if (action === "add_section") {
        await createSectionWithLessons(operation);
        appliedChanges += 1;
      }
    }

    if (appliedChanges === 0) {
      throw new ApiError(
        400,
        "AI did not produce applicable section/curriculum updates. Please mention exact section or curriculum titles, or say 'all sections and all curriculums'.",
      );
    }
  } else if (target === "course_basics") {
    await prisma.course.update({
      where: { id: course.id },
      data: {
        title: trimForDb(parsed?.title || course.title, 60) || course.title,
        subtitle: trimForDb(parsed?.subtitle || course.subtitle, 180) || null,
        description:
          trimForDb(parsed?.description || course.description, 8000) || null,
        language: trimForDb(parsed?.language || course.language || "English", 100),
        welcomeMessage: normalizeNullableAiMessage(
          parsed?.welcome_message ?? parsed?.welcomeMessage,
          course.welcomeMessage,
        ),
        congratulationsMessage: normalizeNullableAiMessage(
          parsed?.congratulations_message ?? parsed?.congratulationsMessage,
          course.congratulationsMessage,
        ),
      },
    });
  } else if (target === "section") {
    const sectionTerms = buildAIDraftFocusTerms(
      `${parsed?.description || ""} ${selectedSection?.description || ""} ${selectedSection?.title || ""} ${course.title} ${prompt}`,
    );
    const titleCandidate =
      trimForDb(parsed?.title, 160) && !looksLikeGenericSectionTitle(parsed?.title)
        ? parsed?.title
        : suggestSectionTitleFromTerms(
            0,
            sectionTerms.length ? sectionTerms : aiUpdateFocusTerms,
            course.title,
          );
    const nextSectionTitle = ensureUniqueTitle(
      titleCandidate,
      usedSectionTitles,
      160,
      selectedSection.title || "Course Topic",
    );
    await prisma.courseSection.update({
      where: { id: selectedSection.id },
      data: {
        title: nextSectionTitle,
        description: resolveSectionObjectiveText(
          parsed?.description || selectedSection.description,
          nextSectionTitle,
          course.title,
        ),
      },
    });
  } else if (target === "curriculum") {
    const nextType = normalizeAISuggestedLessonType(
      parsed?.type || selectedLesson.type || "RESOURCE",
    );
    const usedLessonTitles =
      usedLessonTitlesBySectionId.get(selectedSection?.id) || new Set();
    if (selectedSection?.id && !usedLessonTitlesBySectionId.has(selectedSection.id)) {
      usedLessonTitlesBySectionId.set(selectedSection.id, usedLessonTitles);
    }
    const lessonTerms = buildAIDraftFocusTerms(
      `${nextDescription} ${parsed?.title || ""} ${selectedLesson?.title || ""} ${selectedSection?.title || ""} ${course.title} ${prompt}`,
    );
    const nextTitle = ensureUniqueTitle(
      trimForDb(parsed?.title, 180) && !looksLikeGenericLessonTitle(parsed?.title)
        ? parsed?.title
        : suggestLessonTitleFromTerms(
            selectedSection?.title || "Course Topic",
            0,
            lessonTerms.length ? lessonTerms : aiUpdateFocusTerms,
          ),
      usedLessonTitles,
      180,
      selectedLesson.title || `Applied ${selectedSection?.title || "Course"} Topic`,
    );
    const nextDescription = resolveCurriculumDescriptionText(
      parsed?.description || selectedLesson.description,
      nextTitle,
      selectedSection?.title || "",
      course.title,
    );
    await prisma.lesson.update({
      where: { id: selectedLesson.id },
      data: {
        title: nextTitle,
        description: nextDescription,
        type: nextType,
        assignmentText:
          nextType === "RESOURCE" || nextType === "ASSIGNMENT"
            ? nextDescription
            : null,
      },
    });
    const bestTopic = pickBestTopicForAIGeneratedLesson(updateTopicCatalog, {
      topicHint: parsed?.topic_hint || parsed?.topic || "",
      title: nextTitle,
      description: nextDescription,
      sectionTitle: selectedSection?.title || "",
      courseTitle: course.title,
      courseDescription: course.description || "",
    });
    if (bestTopic?.id) {
      await prisma.lesson.update({
        where: { id: selectedLesson.id },
        data: { topicId: bestTopic.id },
      });
      if (supportsLessonTopics && prisma.lessonTopic) {
        await prisma.lessonTopic.deleteMany({
          where: { lessonId: selectedLesson.id },
        });
        await prisma.lessonTopic.create({
          data: {
            lessonId: selectedLesson.id,
            topicId: bestTopic.id,
          },
        });
      }
    }
  } else if (target === "new_section") {
    await createSectionWithLessons(parsed);
  }

  const refreshedCourse = await getCourseForManagement(
    { id: userId, roles: ["EDUCATOR"] },
    course.id,
  );

  return {
    target,
    course: refreshedCourse,
  };
}

export async function updateCoursePricing(userId, courseId, priceTierId) {
  const course = await prisma.course.findFirst({
    where: { id: courseId, educatorId: userId, deletedAt: null },
  });
  if (!course) {
    throw new ApiError(404, "Course not found");
  }

  return prisma.course.update({
    where: { id: courseId },
    data: { priceTierId: priceTierId || null },
    include: { priceTier: true },
  });
}

function inferCouponTypeLabel(coupon, basePrice) {
  const usageLimit = Number(coupon?.usageLimit || 0);
  const discountValue = Number(coupon?.value || 0);
  const salePrice = Math.max(0, Number(basePrice || 0) - discountValue);

  if (salePrice <= 0) {
    if (usageLimit === 10) return "Free: Open";
    if (usageLimit === 100) return "Free: Targeted";
    return "Free";
  }

  return "Custom price";
}

function mapCouponForManagement(coupon, basePrice) {
  const safeBasePrice = Number(basePrice || 0);
  const safeDiscount = Number(coupon?.value || 0);
  const salePrice = Math.max(0, safeBasePrice - safeDiscount);
  const usedCount = Number(coupon.usedCount || 0);
  const maxRedemptions =
    coupon.usageLimit === null || coupon.usageLimit === undefined
      ? null
      : Number(coupon.usageLimit);
  const remainingRedemptions =
    maxRedemptions === null ? null : Math.max(0, maxRedemptions - usedCount);

  return {
    id: coupon.id,
    code: coupon.code,
    couponType: coupon.type,
    couponTypeLabel: inferCouponTypeLabel(coupon, safeBasePrice),
    basePrice: Number(safeBasePrice.toFixed(2)),
    salePrice: Number(salePrice.toFixed(2)),
    discountAmount: Number(safeDiscount.toFixed(2)),
    startAt: coupon.startsAt,
    endAt: coupon.endsAt,
    maxRedemptions,
    usedCount,
    remainingRedemptions,
    isActive: Boolean(coupon.isActive),
    createdAt: coupon.createdAt,
    updatedAt: coupon.updatedAt,
  };
}

function ensureCouponModelSupportsCourseScope() {
  const couponFields =
    prisma?._runtimeDataModel?.models?.Coupon?.fields?.map((field) => field.name) ||
    [];
  const hasCourseId = couponFields.includes("courseId");
  const hasCreatedById = couponFields.includes("createdById");

  if (hasCourseId && hasCreatedById) return;

  throw new ApiError(
    500,
    "Coupon model is outdated. Run `npm run prisma:generate`, apply migrations, and restart backend.",
  );
}

async function resolveOwnedCourseForCoupon(userId, courseId) {
  const course = await prisma.course.findFirst({
    where: { id: courseId, deletedAt: null },
    include: { priceTier: true },
  });
  if (!course) {
    throw new ApiError(404, "Course not found");
  }
  if (course.educatorId !== userId) {
    throw new ApiError(403, "You can only manage your own course coupons");
  }
  return course;
}

export async function listCourseCouponsForManagement(userId, courseId) {
  ensureCouponModelSupportsCourseScope();
  const course = await resolveOwnedCourseForCoupon(userId, courseId);

  const coupons = await prisma.coupon.findMany({
    where: {
      courseId: course.id,
      deletedAt: null,
    },
    orderBy: [{ createdAt: "desc" }],
  });

  const basePrice = Number(course?.priceTier?.price || 0);
  return coupons.map((coupon) => mapCouponForManagement(coupon, basePrice));
}

export async function createCourseCoupon(userId, courseId, payload) {
  ensureCouponModelSupportsCourseScope();
  const course = await resolveOwnedCourseForCoupon(userId, courseId);
  const basePrice = Number(course?.priceTier?.price || 0);
  if (basePrice <= 0) {
    throw new ApiError(400, "Set a paid course price before creating coupons");
  }

  const code = String(payload?.code || "").trim().toUpperCase();
  if (!code) {
    throw new ApiError(400, "Coupon code is required");
  }

  const existingCoupon = await prisma.coupon.findFirst({
    where: {
      code: {
        equals: code,
        mode: "insensitive",
      },
      deletedAt: null,
    },
    select: { id: true },
  });
  if (existingCoupon) {
    throw new ApiError(409, "Coupon code already exists");
  }

  const salePriceInput = Number(payload?.salePrice || 0);
  if (!Number.isFinite(salePriceInput) || salePriceInput < 0) {
    throw new ApiError(400, "Invalid sale price");
  }
  if (salePriceInput >= basePrice) {
    throw new ApiError(400, "Sale price must be lower than the base course price");
  }

  const startAt = payload?.startAt ? new Date(payload.startAt) : null;
  const endAt = payload?.endAt ? new Date(payload.endAt) : null;
  if (startAt && Number.isNaN(startAt.getTime())) {
    throw new ApiError(400, "Invalid coupon start date");
  }
  if (endAt && Number.isNaN(endAt.getTime())) {
    throw new ApiError(400, "Invalid coupon end date");
  }
  if (startAt && endAt && endAt.getTime() <= startAt.getTime()) {
    throw new ApiError(400, "Coupon end date should be after start date");
  }

  const usageLimitRaw = payload?.maxRedemptions;
  const usageLimit =
    usageLimitRaw === null || usageLimitRaw === undefined || usageLimitRaw === ""
      ? null
      : Number(usageLimitRaw);
  if (
    usageLimit !== null &&
    (!Number.isInteger(usageLimit) || usageLimit <= 0)
  ) {
    throw new ApiError(400, "Max redemptions must be a positive whole number");
  }

  const discountValue = Number(Math.max(0, basePrice - salePriceInput).toFixed(2));
  if (discountValue <= 0) {
    throw new ApiError(400, "Coupon must provide a valid discount");
  }

  const createdCoupon = await prisma.coupon.create({
    data: {
      courseId: course.id,
      createdById: userId,
      code,
      type: "FIXED",
      value: discountValue,
      usageLimit,
      startsAt: startAt,
      endsAt: endAt,
      isActive: true,
    },
  });

  return mapCouponForManagement(createdCoupon, basePrice);
}
