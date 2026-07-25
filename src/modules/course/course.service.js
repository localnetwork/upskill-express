import { prisma } from "../../shared/database/prisma.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { getPagination, toPagedResult } from "../../shared/utils/pagination.js";
import { slugify } from "../../shared/utils/slugify.js";
import { recordActivityEvent } from "../analytics/analytics.service.js";

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
      select: { id: true, username: true, firstName: true, lastName: true },
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
  const base = slugify(title);
  const count = await prisma.course.count({
    where: { slug: { startsWith: base } },
  });
  return count > 0 ? `${base}-${count + 1}` : base;
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
  if (normalized.slug) {
    await assertCourseSlugAvailable(normalized.slug);
  }
  const course = await prisma.course.create({
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

  return prisma.$transaction(async (tx) => {
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

    const hydratedCourse = await tx.course.findFirst({
      where: { id: updatedCourse.id },
      include: getCourseInclude(),
    });

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
  });
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
        educator: { select: { id: true, email: true, username: true, firstName: true, lastName: true } },
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

  const mappedRows = rows.map((course) => ({
    ...course,
    goals: courseGoalsMap.get(course.id) || normalizeGoalsPayload({}),
    is_in_cart: cartCourseIds.has(course.id),
    is_enrolled: enrolledCourseIds.has(course.id),
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

  const [
    totalStudents,
    enrollmentsThisMonth,
    completedStudents,
    progressRows,
    reviewAggregate,
    ratingBuckets,
    revenueAggregate,
    monthlyRevenueAggregate,
    enrollmentTrendRows,
    totalImpressions,
    totalPageViews,
    uniqueImpressionUsers,
    uniqueImpressionSessions,
    uniquePageViewUsers,
    uniquePageViewSessions,
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
    prisma.orderItem.aggregate({
      where: {
        courseId: course.id,
        order: { status: "PAID" },
      },
      _sum: { educatorEarning: true },
    }),
    prisma.orderItem.aggregate({
      where: {
        courseId: course.id,
        order: { status: "PAID" },
        createdAt: { gte: startOfMonth },
      },
      _sum: { educatorEarning: true },
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
      ? activityEventModel.count({
          where: {
            courseId: course.id,
            eventType: "COURSE_PAGE_VIEW",
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
    activityEventModel
      ? activityEventModel.findMany({
          where: {
            courseId: course.id,
            eventType: "COURSE_PAGE_VIEW",
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
            eventType: "COURSE_PAGE_VIEW",
            sessionKey: { not: null },
          },
          distinct: ["sessionKey"],
          select: { sessionKey: true },
        })
      : Promise.resolve([]),
  ]);

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
      total_revenue: Number(revenueAggregate?._sum?.educatorEarning || 0),
      revenue_this_month: Number(monthlyRevenueAggregate?._sum?.educatorEarning || 0),
      total_impressions: totalImpressions,
      total_page_views: totalPageViews,
      unique_impression_visitors: Math.max(
        uniqueImpressionUsers.length,
        uniqueImpressionSessions.length,
      ),
      unique_page_view_visitors: Math.max(
        uniquePageViewUsers.length,
        uniquePageViewSessions.length,
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

  const [monthlyEnrollments, ratingAggregates] = await Promise.all([
    prisma.enrollment.groupBy({
      by: ["courseId"],
      where: {
        courseId: { in: courseIds },
        status: { in: ["ACTIVE", "COMPLETED"] },
        enrolledAt: { gte: startOfMonth },
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
    stats: {
      enrollments_this_month: monthlyByCourseId.get(row.id) || 0,
      average_rating: ratingsByCourseId.get(row.id)?.average_rating || 0,
      total_reviews: ratingsByCourseId.get(row.id)?.total_reviews || 0,
    },
  }));

  return toPagedResult(withStats, total, page, limit);
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
          lessons: { orderBy: { position: "asc" } },
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

  const [isEnrolled, isInCart, isInWishlist] = actor?.id
    ? await Promise.all([
        prisma.enrollment.findFirst({ where: { userId: actor.id, courseId: course.id } }),
        prisma.cartItem.findFirst({
          where: {
            courseId: course.id,
            cart: { userId: actor.id },
          },
        }),
        prisma.wishlist.findFirst({
          where: {
            userId: actor.id,
            courseId: course.id,
          },
        }),
      ])
    : [null, null, null];

  const goals = await readCourseGoals(course.id);
  const coverImage = mapLegacyMedia(
    pickLatestMediaByTypes(course.media, COVER_MEDIA_TYPES),
  );
  const promoVideo = mapLegacyMedia(
    pickLatestMediaByTypes(course.media, PROMO_MEDIA_TYPES),
  );

  return {
    id: course.id,
    slug: course.slug,
    title: course.title,
    subtitle: course.subtitle,
    description: course.description,
    categories: course.category
      ? [{ id: course.category.id, slug: course.category.slug, title: course.category.name || course.category.title }]
      : [],
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
