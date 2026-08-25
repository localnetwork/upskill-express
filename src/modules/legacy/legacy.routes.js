import path from "path";
import { Readable } from "stream";
import fs from "fs/promises";
import jwt from "jsonwebtoken";
import { randomUUID } from "crypto";
import { Router } from "express";
import { prisma } from "../../shared/database/prisma.js";
import { env } from "../../shared/config/env.js";
import { authenticate } from "../../shared/middleware/auth.middleware.js";
import { authorize } from "../../shared/middleware/rbac.middleware.js";
import { cacheGetResponse } from "../../shared/middleware/cache.middleware.js";
import { upload } from "../../shared/middleware/upload.middleware.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import {
  signAccessToken,
  signRefreshToken,
  verifyPreAuthToken,
} from "../../shared/utils/jwt.js";
import { hashToken } from "../../shared/utils/security.js";
import { mapPermissionsFromRoles } from "../../shared/utils/rolePermissions.js";
import {
  deleteObjectFromR2,
  getObjectFromR2,
  isR2Enabled,
  isR2StoragePath,
} from "../../shared/storage/r2.js";
import {
  buildCloudflareEmbedUrlFromPlaybackUrl,
  buildCloudflarePlaybackUrl,
  buildCloudflareSignedEmbedUrl,
  createCloudflareDirectUpload,
  deleteCloudflareStreamVideo,
  extractCloudflareVideoIdFromPlaybackUrl,
  isCloudflareStreamEnabled,
  triggerCloudflareAutoCaption,
  uploadVideoToCloudflareStream,
} from "../../shared/storage/cloudflare-stream.js";
import { updateLessonProgress } from "../progress/progress.service.js";
import { recordActivityEvent } from "../analytics/analytics.service.js";
import { createNotification } from "../notification/notification.service.js";
import {
  consumeBackupCode,
  countBackupCodes,
  createTwoFactorSetup,
  generateBackupCodes,
  verifyTotpToken,
} from "../auth/two-factor.service.js";
import {
  buildDeviceName,
  hasActiveTrustedDeviceByIdentifier,
  getRequestIpAddress,
  getRequestUserAgent,
  registerTrustedDevice,
  resolveDeviceLocationLabel,
} from "../auth/trusted-device.service.js";
import {
  assertLessonUnlockedForEnrollment,
  assertLessonUnlockedForUser,
} from "../progress/lesson-access.service.js";

const router = Router();
const supportsLessonTopics = Boolean(prisma.lessonTopic);
const QUIZ_ATTEMPT_KEY_PREFIX = "quiz_attempt::";
const codingSubmissionStore = new Map();
const JUDGE0_BASE_URL = String(
  process.env.JUDGE0_BASE_URL || "https://ce.judge0.com",
).replace(/\/+$/, "");
const JUDGE0_LANGUAGE_IDS = {
  javascript: 63,
  typescript: 74,
  python: 71,
  java: 62,
  php: 68,
  go: 60,
  csharp: 51,
};

function mapVideoPlaybackToEmbedUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const embedUrl = buildCloudflareEmbedUrlFromPlaybackUrl(raw);
  return embedUrl || raw;
}
const USER_PICTURE_KEY_PREFIX = "profile_picture::";

function getUserPictureSettingKey(userId) {
  return `${USER_PICTURE_KEY_PREFIX}${userId}`;
}

function getUserRoles(user) {
  return (user.roles || []).map((item) => item.role.name);
}

function buildTokenPayload(user) {
  return {
    sub: user.id,
    email: user.email,
    roles: getUserRoles(user),
  };
}

function mapAuthUser(user) {
  const roles = getUserRoles(user);
  const permissions = mapPermissionsFromRoles(roles);

  return {
    id: user.id,
    email: user.email,
    username: user.username,
    firstName: user.firstName,
    lastName: user.lastName,
    firstname: user.firstName,
    lastname: user.lastName,
    verified: Boolean(user.emailVerifiedAt),
    isActive: user.isActive,
    is_suspended: !user.isActive,
    roles,
    permissions,
  };
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

async function notifyNewDeviceLogin(
  userId,
  { deviceName, locationLabel, ipAddress, provider },
) {
  await createNotification({
    userId,
    type: "SYSTEM",
    title: "New device login detected",
    message: `A new device signed in to your account from ${locationLabel || ipAddress || "an unknown location"}.`,
    metadata: {
      notificationKind: "SECURITY_NEW_DEVICE_LOGIN",
      provider: provider || "password",
      deviceName: deviceName || "Unknown device",
      locationLabel: locationLabel || null,
      ipAddress: ipAddress || null,
    },
  });
}

async function findUserWithRolesById(id) {
  return prisma.user.findUnique({
    where: { id },
    include: {
      roles: {
        include: {
          role: true,
        },
      },
    },
  });
}

router.use(
  cacheGetResponse({
    prefix: "legacy:get",
    ttlSeconds: 60,
    varyByUser: true,
    tags: ["legacy", "courses", "users", "orders", "payouts", "notifications"],
  }),
);

function mediaPath(file) {
  if (!file) return null;
  if (file.path) return file.path;
  return file.filename ? `/uploads/${file.filename}` : null;
}

async function readUploadedFileBuffer(file) {
  const storagePath = mediaPath(file);
  if (!storagePath) {
    throw new ApiError(400, "Uploaded file path is missing");
  }

  if (file?.buffer) {
    return Buffer.from(file.buffer);
  }

  if (file?.key && isR2Enabled()) {
    const object = await getObjectFromR2(file.key);
    if (typeof object.body.transformToByteArray === "function") {
      const bytes = await object.body.transformToByteArray();
      return Buffer.from(bytes);
    }
    if (typeof object.body.transformToWebStream === "function") {
      const chunks = [];
      for await (const chunk of Readable.fromWeb(object.body.transformToWebStream())) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    }
    if (typeof object.body.pipe === "function") {
      const chunks = [];
      for await (const chunk of object.body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    }
    throw new ApiError(500, "Unsupported uploaded file format from R2");
  }

  if (isR2Enabled() && isR2StoragePath(storagePath)) {
    const object = await getObjectFromR2(storagePath);
    if (typeof object.body.transformToByteArray === "function") {
      const bytes = await object.body.transformToByteArray();
      return Buffer.from(bytes);
    }
    if (typeof object.body.transformToWebStream === "function") {
      const chunks = [];
      for await (const chunk of Readable.fromWeb(object.body.transformToWebStream())) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    }
    if (typeof object.body.pipe === "function") {
      const chunks = [];
      for await (const chunk of object.body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    }
    throw new ApiError(500, "Unsupported uploaded file format from R2");
  }

  if (/^https?:\/\//i.test(storagePath)) {
    const response = await fetch(storagePath);
    if (!response.ok) {
      throw new ApiError(502, "Failed to fetch uploaded file for processing");
    }
    const bytes = await response.arrayBuffer();
    return Buffer.from(bytes);
  }

  return fs.readFile(storagePath);
}

async function cleanupTransientUploadedFile(file) {
  const storagePath = mediaPath(file);
  if (!storagePath) return;

  if (file?.key) {
    await deleteObjectFromR2(file.key).catch(() => {});
    return;
  }

  if (!/^https?:\/\//i.test(storagePath)) {
    await fs.unlink(storagePath).catch(() => {});
  }
}

function normalizeExtendedProfile(payload = {}) {
  return {
    headline: payload.headline || "",
    biography: payload.biography || "",
    link_website: payload.link_website || "",
    link_facebook: payload.link_facebook || "",
    link_instagram: payload.link_instagram || "",
    link_linkedin: payload.link_linkedin || "",
    link_tiktok: payload.link_tiktok || "",
    link_x: payload.link_x || "",
    link_youtube: payload.link_youtube || "",
    link_github: payload.link_github || "",
  };
}

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

function mapLessonTypeToLegacyResource(type, lesson) {
  if (type === "QUIZ") return "quiz";
  if (type === "CODING_EXERCISE") return "coding_exercise";
  if (type === "VIDEO" || lesson.videoUrl) return "video";
  if (lesson.assignmentText) return "article";
  return "null";
}

function parseJsonOrNull(value) {
  if (!value) return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
}

function lessonIncludeForTopics() {
  return supportsLessonTopics
    ? {
        topic: true,
        lessonTopics: {
          include: {
            topic: true,
          },
        },
      }
    : {
        topic: true,
      };
}

function normalizeLessonUnlockType(value) {
  const normalized = String(value || "IMMEDIATE").trim().toUpperCase();
  if (
    normalized === "DATE" ||
    normalized === "AFTER_PREVIOUS" ||
    normalized === "AFTER_CUSTOM"
  ) {
    return normalized;
  }
  return "IMMEDIATE";
}

function parseLessonUnlockAt(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new ApiError(400, "Invalid unlock date value");
  }
  return parsed;
}

function extractLessonUnlockRuleFromBody(body = {}) {
  const unlockTypeInput =
    body.unlock_type !== undefined ? body.unlock_type : body.unlockType;
  const unlockAtInput =
    body.unlock_at !== undefined ? body.unlock_at : body.unlockAt;
  const prerequisiteLessonIdInput =
    body.prerequisite_lesson_id !== undefined
      ? body.prerequisite_lesson_id
      : body.prerequisiteLessonId;

  const unlockType = normalizeLessonUnlockType(unlockTypeInput);
  const unlockAt = parseLessonUnlockAt(unlockAtInput);
  const prerequisiteLessonId =
    String(prerequisiteLessonIdInput || "").trim() || null;

  if (unlockType === "DATE" && !unlockAt) {
    throw new ApiError(400, "unlock_at is required when unlock_type is DATE");
  }
  if (unlockType === "AFTER_CUSTOM" && !prerequisiteLessonId) {
    throw new ApiError(
      400,
      "prerequisite_lesson_id is required when unlock_type is AFTER_CUSTOM",
    );
  }

  return {
    unlockType,
    unlockAt: unlockType === "DATE" ? unlockAt : null,
    prerequisiteLessonId:
      unlockType === "AFTER_CUSTOM" ? prerequisiteLessonId : null,
  };
}

function mapLessonToLegacyCurriculum(lesson) {
  const parsedCodingStarterCode = parseJsonOrNull(lesson.codingStarterCode);
  const parsedQuizQuestions = parseJsonOrNull(lesson.quizQuestions);
  const topicRows = Array.isArray(lesson.lessonTopics)
    ? lesson.lessonTopics
        .map((row) => row?.topic)
        .filter(Boolean)
        .map((topic) => ({
          id: topic.id,
          title: topic.name,
          slug: topic.slug,
          category_id: topic.categoryId,
        }))
    : [];
  const fallbackTopic = lesson.topic
    ? {
        id: lesson.topic.id,
        title: lesson.topic.name,
        slug: lesson.topic.slug,
        category_id: lesson.topic.categoryId,
      }
    : null;
  const topics =
    topicRows.length > 0 ? topicRows : fallbackTopic ? [fallbackTopic] : [];
  const primaryTopicId = topics[0]?.id || lesson.topicId || null;

  return {
    id: lesson.id,
    uuid: lesson.id,
    title: lesson.title,
    curriculum_type:
      lesson.type === "QUIZ"
        ? "quiz"
        : lesson.type === "CODING_EXERCISE"
          ? "coding_exercise"
          : lesson.type === "ASSIGNMENT"
            ? "assignment"
            : "lecture",
    curriculum_description: lesson.description || "",
    curriculum_resource_type: mapLessonTypeToLegacyResource(
      lesson.type,
      lesson,
    ),
    estimated_duration: lesson.durationInSeconds || 0,
    topic_id: primaryTopicId,
    topic_ids: topics.map((topic) => topic.id),
    topic: topics[0] || null,
    topics,
    is_public_preview: Boolean(lesson.isPreview),
    is_preview: Boolean(lesson.isPreview),
    unlock_type: String(lesson.unlockType || "IMMEDIATE").toLowerCase(),
    unlock_at: lesson.unlockAt || null,
    prerequisite_lesson_id: lesson.prerequisiteLessonId || null,
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
                parsedCodingStarterCode?.starter_code ||
                parsedCodingStarterCode ||
                {},
              expected_output: parsedCodingStarterCode?.expected_output || {},
              languages: parsedCodingStarterCode?.languages || [],
              test_cases: parsedCodingStarterCode?.test_cases || {},
              step_challenges:
                parsedCodingStarterCode?.step_challenges &&
                typeof parsedCodingStarterCode.step_challenges === "object"
                  ? parsedCodingStarterCode.step_challenges
                  : {},
              checklist: Array.isArray(parsedCodingStarterCode?.checklist)
                ? parsedCodingStarterCode.checklist
                    .map((item) => String(item || "").trim())
                    .filter(Boolean)
                : [],
              hints: Array.isArray(parsedCodingStarterCode?.hints)
                ? parsedCodingStarterCode.hints
                    .map((item) => String(item || "").trim())
                    .filter(Boolean)
                : [],
            }
          : lesson.videoUrl
            ? { path: mapVideoPlaybackToEmbedUrl(lesson.videoUrl) }
            : lesson.assignmentText
              ? { content: lesson.assignmentText }
              : null,
  };
}

async function ensureEducatorOwnsCourse(userId, courseId) {
  const course = await prisma.course.findFirst({
    where: { id: courseId, educatorId: userId, deletedAt: null },
  });
  if (!course) {
    throw new ApiError(404, "Course not found");
  }
  return course;
}

async function ensureEducatorOwnsSection(userId, sectionId) {
  const section = await prisma.courseSection.findFirst({
    where: {
      id: sectionId,
      course: {
        educatorId: userId,
        deletedAt: null,
      },
    },
    include: { course: true },
  });
  if (!section) {
    throw new ApiError(404, "Section not found");
  }
  return section;
}

async function ensureEducatorOwnsLesson(userId, lessonId) {
  const lesson = await prisma.lesson.findFirst({
    where: {
      id: lessonId,
      course: {
        educatorId: userId,
        deletedAt: null,
      },
    },
    include: { course: true },
  });
  if (!lesson) {
    throw new ApiError(404, "Curriculum not found");
  }
  return lesson;
}

function normalizeTopicIds(input) {
  if (input === undefined) return [];
  const rawList = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.split(",")
      : [input];
  const normalized = rawList
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return Array.from(new Set(normalized));
}

function extractTopicIdsFromRequestBody(body = {}) {
  if (body.topicIds !== undefined) return normalizeTopicIds(body.topicIds);
  if (body.topic_ids !== undefined) return normalizeTopicIds(body.topic_ids);
  if (body.topicId !== undefined) return normalizeTopicIds(body.topicId);
  if (body.topic_id !== undefined) return normalizeTopicIds(body.topic_id);
  return undefined;
}

async function resolveCurriculumTopicsForCourse(course, topicIds) {
  const normalizedTopicIds = normalizeTopicIds(topicIds);
  if (!normalizedTopicIds.length) {
    return [];
  }

  if (!course?.categoryId) {
    throw new ApiError(
      400,
      "Course category is required before assigning a curriculum topic",
    );
  }

  const topics = await prisma.topic.findMany({
    where: {
      id: { in: normalizedTopicIds },
      deletedAt: null,
    },
    include: {
      category: {
        select: {
          id: true,
          parentId: true,
          deletedAt: true,
        },
      },
    },
  });

  if (topics.length !== normalizedTopicIds.length) {
    throw new ApiError(400, "One or more topics are invalid");
  }

  const topicMap = new Map(topics.map((topic) => [topic.id, topic]));

  for (const topicId of normalizedTopicIds) {
    const topic = topicMap.get(topicId);
    if (!topic || !topic.category || topic.category.deletedAt) {
      throw new ApiError(400, "One or more topics are invalid");
    }
    const belongsToCourseCategory =
      topic.categoryId === course.categoryId ||
      topic.category.parentId === course.categoryId;
    if (!belongsToCourseCategory) {
      throw new ApiError(
        400,
        "Topic does not belong to the selected course category",
      );
    }
  }

  return normalizedTopicIds.map((topicId) => topicMap.get(topicId));
}

async function ensureLearnerOwnsQuizLesson(userId, lessonId) {
  const lesson = await prisma.lesson.findUnique({
    where: { id: String(lessonId) },
    include: {
      course: true,
    },
  });

  if (!lesson || !lesson.course || lesson.course.deletedAt) {
    throw new ApiError(404, "Lesson not found");
  }

  const enrollment = await prisma.enrollment.findFirst({
    where: {
      userId,
      courseId: lesson.courseId,
      status: "ACTIVE",
    },
  });

  if (!enrollment) {
    throw new ApiError(403, "Not enrolled in this course");
  }

  if (lesson.type !== "QUIZ") {
    throw new ApiError(400, "This lesson is not a quiz");
  }

  return { lesson, enrollment };
}

async function ensureLearnerOwnsCodingLesson(userId, lessonId) {
  const lesson = await prisma.lesson.findUnique({
    where: { id: String(lessonId) },
    include: {
      course: true,
    },
  });

  if (!lesson || !lesson.course || lesson.course.deletedAt) {
    throw new ApiError(404, "Lesson not found");
  }

  const enrollment = await prisma.enrollment.findFirst({
    where: {
      userId,
      courseId: lesson.courseId,
      status: "ACTIVE",
    },
  });

  if (!enrollment) {
    throw new ApiError(403, "Not enrolled in this course");
  }

  if (lesson.type !== "CODING_EXERCISE") {
    throw new ApiError(400, "This lesson is not a coding exercise");
  }

  return { lesson, enrollment };
}

function normalizeCodingAsset(rawValue) {
  const parsed = parseJsonOrDefault(rawValue, {});
  if (!parsed || typeof parsed !== "object") {
    return {
      languages: ["javascript"],
      starter_code: {},
      expected_output: {},
      test_cases: {},
      step_challenges: {},
      checklist: [],
      hints: [],
    };
  }

  return {
    languages:
      Array.isArray(parsed.languages) && parsed.languages.length
        ? parsed.languages
        : ["javascript"],
    starter_code:
      parsed.starter_code && typeof parsed.starter_code === "object"
        ? parsed.starter_code
        : {},
    expected_output:
      parsed.expected_output && typeof parsed.expected_output === "object"
        ? parsed.expected_output
        : {},
    test_cases:
      parsed.test_cases && typeof parsed.test_cases === "object"
        ? parsed.test_cases
        : {},
    step_challenges:
      parsed.step_challenges && typeof parsed.step_challenges === "object"
        ? parsed.step_challenges
        : {},
    checklist: Array.isArray(parsed.checklist)
      ? parsed.checklist
          .map((item) => String(item || "").trim())
          .filter(Boolean)
      : [],
    hints: Array.isArray(parsed.hints)
      ? parsed.hints.map((item) => String(item || "").trim()).filter(Boolean)
      : [],
  };
}

function normalizeCodingStepsForLanguage(asset, language) {
  const fromAsset = Array.isArray(asset.step_challenges?.[language])
    ? asset.step_challenges[language]
    : [];

  return fromAsset
    .map((item, index) => {
      const fallbackExpected =
        item?.expected_output ?? item?.expectedOutput ?? "";
      const fallbackMode = String(
        item?.validation_mode || item?.validationMode || "",
      ).toUpperCase();
      const normalizedMode =
        fallbackMode === "EXACT_CODE"
          ? "EXACT_CODE"
          : fallbackMode === "RUN_OUTPUT"
            ? "RUN_OUTPUT"
            : "CODE_INCLUDES";

      const validators = Array.isArray(item?.validators)
        ? item.validators
            .map((validator, validatorIndex) => ({
              id: String(
                validator?.id ||
                  `step-${index + 1}-validator-${validatorIndex + 1}`,
              ),
              name: String(validator?.name || `Check ${validatorIndex + 1}`),
              mode: String(
                validator?.mode || normalizedMode || "CODE_INCLUDES",
              ).toUpperCase(),
              input: String(validator?.input || ""),
              expectedOutput: String(
                validator?.expected_output !== undefined
                  ? validator.expected_output
                  : validator?.expectedOutput || fallbackExpected,
              ),
              visibility:
                String(validator?.visibility || "VISIBLE").toUpperCase() ===
                "HIDDEN"
                  ? "HIDDEN"
                  : "VISIBLE",
              comparisonMode:
                String(
                  validator?.comparison_mode ||
                    validator?.comparisonMode ||
                    "EXACT",
                ).toUpperCase() === "INCLUDES"
                  ? "INCLUDES"
                  : String(
                        validator?.comparison_mode ||
                          validator?.comparisonMode ||
                          "EXACT",
                      ).toUpperCase() === "REGEX"
                    ? "REGEX"
                    : "EXACT",
            }))
            .filter((validator) => validator.expectedOutput !== "")
        : [];

      const fallbackValidators =
        validators.length > 0
          ? validators
          : [
              {
                id: `step-${index + 1}-default-validator`,
                name: "Step check",
                mode: normalizedMode,
                input: String(item?.input || ""),
                expectedOutput: String(fallbackExpected),
                visibility:
                  String(item?.visibility || "VISIBLE").toUpperCase() ===
                  "HIDDEN"
                    ? "HIDDEN"
                    : "VISIBLE",
                comparisonMode:
                  String(
                    item?.comparison_mode || item?.comparisonMode || "EXACT",
                  ).toUpperCase() === "INCLUDES"
                    ? "INCLUDES"
                    : String(
                          item?.comparison_mode ||
                            item?.comparisonMode ||
                            "EXACT",
                        ).toUpperCase() === "REGEX"
                      ? "REGEX"
                      : "EXACT",
              },
            ].filter((validator) => validator.expectedOutput !== "");

      return {
        id: String(item?.id || `${language}-step-${index + 1}`),
        stepNumber: Number(item?.step_number || item?.stepNumber || index + 1),
        title: String(item?.title || `Step ${index + 1}`),
        instruction: String(item?.instruction || item?.instructions || ""),
        starterCode: String(item?.starter_code || item?.starterCode || ""),
        validators: fallbackValidators,
      };
    })
    .filter((item) => item.validators.length > 0)
    .sort((a, b) => a.stepNumber - b.stepNumber);
}

function normalizeCodingTestsForLanguage(asset, language) {
  const fromAsset = Array.isArray(asset.test_cases?.[language])
    ? asset.test_cases[language]
    : [];
  const normalized = fromAsset
    .map((testCase, index) => ({
      id: String(testCase.id || `${language}-tc-${index + 1}`),
      name: String(testCase.name || `Test #${index + 1}`),
      input: String(testCase.input || ""),
      expectedOutput: String(
        testCase.expected_output !== undefined
          ? testCase.expected_output
          : testCase.expectedOutput || "",
      ),
      visibility:
        String(testCase.visibility || "VISIBLE").toUpperCase() === "HIDDEN"
          ? "HIDDEN"
          : "VISIBLE",
      comparisonMode:
        String(
          testCase.comparison_mode || testCase.comparisonMode || "EXACT",
        ).toUpperCase() === "INCLUDES"
          ? "INCLUDES"
          : String(
                testCase.comparison_mode || testCase.comparisonMode || "EXACT",
              ).toUpperCase() === "REGEX"
            ? "REGEX"
            : "EXACT",
    }))
    .filter((item) => item.expectedOutput !== "");

  if (normalized.length > 0) {
    return normalized;
  }

  const fallbackExpected = String(asset.expected_output?.[language] || "");
  if (!fallbackExpected) return [];
  return [
    {
      id: `${language}-default-1`,
      name: "Default output check",
      input: "",
      expectedOutput: fallbackExpected,
      visibility: "VISIBLE",
      comparisonMode: "EXACT",
    },
  ];
}

function compareCodingOutput(actualOutput, expectedOutput, comparisonMode) {
  const actual = String(actualOutput || "").trim();
  const expected = String(expectedOutput || "").trim();

  if (comparisonMode === "INCLUDES") {
    return actual.includes(expected);
  }
  if (comparisonMode === "REGEX") {
    try {
      return new RegExp(expected).test(actual);
    } catch (_error) {
      return false;
    }
  }
  return actual === expected;
}

function compareCodingSource(sourceCode, expectedOutput, mode, comparisonMode) {
  const source = String(sourceCode || "").trim();
  const expected = String(expectedOutput || "").trim();

  if (mode === "EXACT_CODE") {
    return source === expected;
  }

  if (comparisonMode === "INCLUDES" || mode === "CODE_INCLUDES") {
    return source.includes(expected);
  }

  if (comparisonMode === "REGEX") {
    try {
      return new RegExp(expected).test(source);
    } catch (_error) {
      return false;
    }
  }

  return source === expected;
}

async function executeJudge0Code({ language, sourceCode, stdin }) {
  const languageId = JUDGE0_LANGUAGE_IDS[String(language || "").toLowerCase()];
  if (!languageId) {
    throw new ApiError(400, `Unsupported language: ${language}`);
  }

  const response = await fetch(`${JUDGE0_BASE_URL}/submissions?wait=true`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      language_id: languageId,
      source_code: sourceCode,
      stdin: stdin || "",
    }),
  });

  if (!response.ok) {
    throw new ApiError(502, "Coding runner unavailable");
  }

  const payload = await response.json();
  const stdout = String(payload.stdout || "");
  const stderr = String(payload.stderr || "");
  const compileOutput = String(payload.compile_output || "");
  const statusDescription = String(payload.status?.description || "");
  const actualOutput = stdout || compileOutput || stderr || statusDescription;

  return {
    actualOutput,
    stderr,
    compileOutput,
    statusDescription,
    runtimeSeconds: Number(payload.time || 0),
    memoryKb: Number(payload.memory || 0),
    hasExecutionError: Boolean(stderr || compileOutput),
  };
}

function getCodingSubmissionStatus(submissionId) {
  const existing = codingSubmissionStore.get(submissionId);
  if (!existing) {
    throw new ApiError(404, "Coding submission not found");
  }
  return existing;
}

async function processCodingSubmission(submissionId) {
  const submission = getCodingSubmissionStatus(submissionId);
  submission.status = "RUNNING";
  submission.updatedAt = new Date().toISOString();

  try {
    const { lesson } = await ensureLearnerOwnsCodingLesson(
      submission.userId,
      submission.lessonId,
    );
    const asset = normalizeCodingAsset(lesson.codingStarterCode);
    const tests = normalizeCodingTestsForLanguage(asset, submission.language);
    if (!tests.length) {
      throw new ApiError(400, "No test cases configured for this language");
    }

    const resultItems = [];
    for (const testCase of tests) {
      const run = await executeJudge0Code({
        language: submission.language,
        sourceCode: submission.sourceCode,
        stdin: testCase.input,
      });
      const passed =
        !run.hasExecutionError &&
        compareCodingOutput(
          run.actualOutput,
          testCase.expectedOutput,
          testCase.comparisonMode,
        );
      resultItems.push({
        id: testCase.id,
        name: testCase.name,
        input: testCase.input,
        expectedOutput: testCase.expectedOutput,
        actualOutput: run.actualOutput,
        visibility: testCase.visibility,
        comparisonMode: testCase.comparisonMode,
        passed,
        runtimeSeconds: run.runtimeSeconds,
        memoryKb: run.memoryKb,
        statusDescription: run.statusDescription,
        stderr: run.stderr,
        compileOutput: run.compileOutput,
      });
    }

    const allPassed = resultItems.every((item) => item.passed);
    const visibleResults = resultItems
      .filter((item) => item.visibility === "VISIBLE")
      .map((item) => ({
        id: item.id,
        name: item.name,
        input: item.input,
        expectedOutput: item.expectedOutput,
        actualOutput: item.actualOutput,
        comparisonMode: item.comparisonMode,
        passed: item.passed,
        runtimeSeconds: item.runtimeSeconds,
        memoryKb: item.memoryKb,
        statusDescription: item.statusDescription,
        stderr: item.stderr,
        compileOutput: item.compileOutput,
      }));
    const hidden = resultItems.filter((item) => item.visibility === "HIDDEN");

    submission.status = "COMPLETED";
    submission.summary = {
      allPassed,
      totalTests: resultItems.length,
      passedTests: resultItems.filter((item) => item.passed).length,
      visibleResults,
      hiddenSummary: {
        total: hidden.length,
        passed: hidden.filter((item) => item.passed).length,
      },
    };
    submission.updatedAt = new Date().toISOString();

    if (submission.mode === "SUBMIT" && allPassed) {
      await updateLessonProgress(submission.userId, {
        lessonId: lesson.id,
        progressPct: 100,
        isCompleted: true,
        lastPosition: 0,
      });
    }
  } catch (error) {
    submission.status = "FAILED";
    submission.updatedAt = new Date().toISOString();
    submission.error =
      error instanceof ApiError
        ? error.message
        : "Failed to run coding submission";
  }
}

function getQuizAttemptSettingKey(userId, lessonId) {
  return `${QUIZ_ATTEMPT_KEY_PREFIX}${userId}::${lessonId}`;
}

function parseJsonOrDefault(value, fallback) {
  if (!value) return fallback;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return fallback;
  }
}

function normalizeQuizPayload(quizQuestions) {
  const parsed = parseJsonOrDefault(quizQuestions, {});
  const rawQuestions = Array.isArray(parsed) ? parsed : parsed.questions || [];
  const settings = {
    passingScore: Number(parsed?.settings?.passingScore || 80),
    allowSkip: Boolean(parsed?.settings?.allowSkip || false),
    hintPenalty: Number(parsed?.settings?.hintPenalty || 1),
    allowRetakeAfterPass: Boolean(
      parsed?.settings?.allowRetakeAfterPass || false,
    ),
    quizTimerSeconds: Number(parsed?.settings?.quizTimerSeconds || 0),
  };

  return {
    questions: rawQuestions.map((question, index) => ({
      ...question,
      id: question?.id || `q-${index + 1}`,
      type: question?.type || "multiple_choice",
      prompt: question?.prompt || "",
      explanation: question?.explanation || "",
      hint:
        question?.hint ||
        question?.clue ||
        question?.tip ||
        question?.helperText ||
        "",
      points: Number(question?.points || 10),
    })),
    settings,
  };
}

function resolveQuizHintText(question) {
  const explicitHint = String(
    question?.hint ||
      question?.clue ||
      question?.tip ||
      question?.helperText ||
      "",
  ).trim();
  if (explicitHint) return explicitHint;

  const explanation = String(question?.explanation || "").trim();
  if (explanation) {
    return explanation.length > 220
      ? `${explanation.slice(0, 220).trim()}...`
      : explanation;
  }

  if (question?.type === "multiple_choice") {
    const optionLabels = (Array.isArray(question?.options) ? question.options : [])
      .map((option) => String(option?.label || option?.text || "").trim())
      .filter(Boolean)
      .slice(0, 3);
    if (optionLabels.length) {
      return `Review these options carefully: ${optionLabels.join(", ")}. Eliminate unlikely answers first.`;
    }
  }

  if (
    question?.type === "fill_in_the_blanks" ||
    question?.type === "short_answer"
  ) {
    return "Use the core concept from the lesson and focus on precise keywords.";
  }

  if (question?.type === "true_false") {
    return "Look for absolute terms and edge cases before deciding true or false.";
  }

  return "Focus on key concepts in the question prompt and eliminate unlikely options.";
}

function buildQuizAnswerRevealHint(question) {
  const correctAnswer = getCorrectAnswerPayload(question);

  if (question?.type === "multiple_choice") {
    const options = Array.isArray(question?.options) ? question.options : [];
    const indices = Array.isArray(correctAnswer) ? correctAnswer : [];
    const labels = indices
      .map((index) => {
        const option = options[index];
        if (!option) return "";
        return String(option?.label || option?.text || "").trim();
      })
      .filter(Boolean);

    if (labels.length) {
      return `Answer reveal: ${labels.join(", ")}`;
    }
  }

  if (question?.type === "true_false") {
    return `Answer reveal: ${Boolean(correctAnswer) ? "True" : "False"}`;
  }

  if (
    question?.type === "fill_in_the_blanks" ||
    question?.type === "short_answer"
  ) {
    const acceptedAnswers = Array.isArray(correctAnswer) ? correctAnswer : [];
    if (acceptedAnswers.length) {
      return `Answer reveal: ${acceptedAnswers.slice(0, 2).join(" / ")}`;
    }
  }

  return "";
}

function getCorrectAnswerPayload(question) {
  if (question.type === "multiple_choice") {
    const indices = (question.options || [])
      .map((option, index) => ({ option, index }))
      .filter(({ option }) => Boolean(option?.isCorrect))
      .map(({ index }) => index);
    return indices;
  }

  if (question.type === "true_false") {
    return Boolean(question.correctAnswer);
  }

  if (
    question.type === "fill_in_the_blanks" ||
    question.type === "short_answer"
  ) {
    return (question.acceptedAnswers || []).map((value) =>
      String(value || "")
        .trim()
        .toLowerCase(),
    );
  }

  return null;
}

function validateAnswer(question, submittedAnswer) {
  const correctAnswer = getCorrectAnswerPayload(question);

  if (question.type === "multiple_choice") {
    const expected = Array.isArray(correctAnswer) ? correctAnswer : [];
    const selected = Array.isArray(submittedAnswer)
      ? submittedAnswer.map((value) => Number(value))
      : [Number(submittedAnswer)];
    const selectedUnique = Array.from(new Set(selected)).sort((a, b) => a - b);
    const expectedUnique = Array.from(new Set(expected)).sort((a, b) => a - b);
    const isCorrect =
      selectedUnique.length === expectedUnique.length &&
      selectedUnique.every((value, index) => value === expectedUnique[index]);
    return { isCorrect, correctAnswer: expectedUnique };
  }

  if (question.type === "true_false") {
    const normalized = String(submittedAnswer).toLowerCase() === "true";
    return {
      isCorrect: normalized === Boolean(correctAnswer),
      correctAnswer: Boolean(correctAnswer),
    };
  }

  if (
    question.type === "fill_in_the_blanks" ||
    question.type === "short_answer"
  ) {
    const normalized = String(submittedAnswer || "")
      .trim()
      .toLowerCase();
    const accepted = Array.isArray(correctAnswer) ? correctAnswer : [];
    return {
      isCorrect: accepted.includes(normalized),
      correctAnswer: accepted,
    };
  }

  return { isCorrect: false, correctAnswer: null };
}

function computeQuizMetrics(state, totalQuestions, passingScore) {
  const resultEntries = Object.values(state.questionResults || {});
  const answeredQuestions = resultEntries.length;
  const correctAnswers = resultEntries.filter((item) => item?.isCorrect).length;
  const incorrectAnswers = answeredQuestions - correctAnswers;
  const hintsUsed = Object.values(state.hintUsage || {}).filter(Boolean).length;
  const score = resultEntries.reduce(
    (sum, item) => sum + Number(item?.awardedPoints || 0),
    0,
  );
  const maxScore = resultEntries.reduce(
    (sum, item) => sum + Number(item?.maxPoints || 0),
    0,
  );
  const scorePercentage =
    maxScore > 0 ? Number(((score / maxScore) * 100).toFixed(2)) : 0;
  const completionPercentage =
    totalQuestions > 0
      ? Number(((answeredQuestions / totalQuestions) * 100).toFixed(2))
      : 0;
  const completed = answeredQuestions >= totalQuestions && totalQuestions > 0;
  const passed = completed ? scorePercentage >= passingScore : false;
  const startedAt = state.startedAt ? new Date(state.startedAt) : new Date();
  const lastActivityAt = state.lastActivityAt
    ? new Date(state.lastActivityAt)
    : new Date();
  const timeSpentSeconds = Math.max(
    0,
    Math.floor((lastActivityAt.getTime() - startedAt.getTime()) / 1000),
  );

  return {
    totalQuestions,
    answeredQuestions,
    correctAnswers,
    incorrectAnswers,
    hintsUsed,
    score,
    maxScore,
    scorePercentage,
    completionPercentage,
    completed,
    passed,
    timeSpentSeconds,
  };
}

function buildDefaultQuizState(quizPayload) {
  return {
    startedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    currentQuestionIndex: 0,
    answers: {},
    hintUsage: {},
    questionResults: {},
    metrics: computeQuizMetrics(
      { questionResults: {}, hintUsage: {} },
      quizPayload.questions.length,
      quizPayload.settings.passingScore,
    ),
    completed: false,
    passed: false,
    attemptNumber: 1,
    attemptHistory: [],
    completionRecorded: false,
  };
}

async function loadQuizAttemptState(userId, lesson) {
  const quizPayload = normalizeQuizPayload(lesson.quizQuestions);
  const key = getQuizAttemptSettingKey(userId, lesson.id);
  const setting = await prisma.platformSetting.findUnique({
    where: { key },
    select: { value: true },
  });

  const saved = parseJsonOrDefault(setting?.value, null);
  const baseState = saved || buildDefaultQuizState(quizPayload);
  const state = {
    ...buildDefaultQuizState(quizPayload),
    ...baseState,
    lastActivityAt: new Date().toISOString(),
  };
  state.metrics = computeQuizMetrics(
    state,
    quizPayload.questions.length,
    quizPayload.settings.passingScore,
  );
  state.completed = state.metrics.completed;
  state.passed = state.metrics.passed;

  return { key, quizPayload, state };
}

async function saveQuizAttemptState(key, state) {
  await prisma.platformSetting.upsert({
    where: { key },
    create: { key, value: JSON.stringify(state) },
    update: { value: JSON.stringify(state) },
  });
}

async function finalizeQuizCompletion(userId, lessonId, state, quizPayload) {
  const metrics = computeQuizMetrics(
    state,
    quizPayload.questions.length,
    quizPayload.settings.passingScore,
  );
  state.metrics = metrics;
  state.completed = metrics.completed;
  state.passed = metrics.passed;

  if (!metrics.completed) {
    return state;
  }

  if (!state.completionRecorded) {
    state.attemptHistory = Array.isArray(state.attemptHistory)
      ? state.attemptHistory
      : [];
    state.attemptHistory.push({
      attemptNumber: state.attemptNumber || 1,
      completedAt: new Date().toISOString(),
      passed: metrics.passed,
      score: metrics.score,
      scorePercentage: metrics.scorePercentage,
      correctAnswers: metrics.correctAnswers,
      incorrectAnswers: metrics.incorrectAnswers,
      hintsUsed: metrics.hintsUsed,
      completionPercentage: metrics.completionPercentage,
      timeSpentSeconds: metrics.timeSpentSeconds,
    });
    state.completionRecorded = true;
  }

  await updateLessonProgress(userId, {
    lessonId,
    progressPct: metrics.passed ? 100 : metrics.scorePercentage,
    isCompleted: metrics.passed,
    lastPosition: 0,
  });

  return state;
}

async function canAccessCourseMedia(userId, courseId) {
  const [course, enrollment] = await Promise.all([
    prisma.course.findFirst({
      where: {
        id: courseId,
        educatorId: userId,
        deletedAt: null,
      },
      select: { id: true },
    }),
    prisma.enrollment.findFirst({
      where: {
        userId,
        courseId,
        status: "ACTIVE",
      },
      select: { id: true },
    }),
  ]);

  return Boolean(course || enrollment);
}

async function resolveLessonVideoById(id) {
  const lesson = await prisma.lesson.findUnique({
    where: { id: String(id) },
    include: {
      media: {
        where: { mediaType: "VIDEO" },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
    },
  });

  if (!lesson) {
    return null;
  }

  const storagePath = lesson.videoUrl || lesson.media?.[0]?.storagePath || null;
  return {
    lessonId: lesson.id,
    courseId: lesson.courseId,
    storagePath,
  };
}

async function resolveMediaSourceByQueryId(id) {
  const media = await prisma.media.findUnique({
    where: { id: String(id) },
    include: {
      lesson: {
        select: { id: true, courseId: true },
      },
    },
  });

  if (media) {
    return {
      userId: media.userId,
      lessonId: media.lesson?.id || media.lessonId || null,
      courseId: media.lesson?.courseId || media.courseId || null,
      storagePath: media.storagePath,
    };
  }

  const lessonVideo = await resolveLessonVideoById(id);
  if (lessonVideo) {
    return {
      userId: null,
      lessonId: lessonVideo.lessonId,
      courseId: lessonVideo.courseId,
      storagePath: lessonVideo.storagePath,
    };
  }

  return null;
}

async function resolvePublicPreviewMediaByQueryId(id) {
  const lesson = await prisma.lesson.findUnique({
    where: { id: String(id) },
    select: {
      isPreview: true,
      type: true,
      videoUrl: true,
      media: {
        where: { mediaType: "VIDEO" },
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          storagePath: true,
        },
      },
      course: {
        select: {
          workflowStatus: true,
          isPublished: true,
          deletedAt: true,
        },
      },
    },
  });

  if (!lesson || !lesson.isPreview) {
    return null;
  }

  if (lesson.type !== "VIDEO" && !lesson.videoUrl) {
    return null;
  }

  if (!lesson.course || lesson.course.deletedAt) {
    return null;
  }

  const isCoursePublic =
    lesson.course.workflowStatus === "PUBLISHED" ||
    lesson.course.isPublished === true;
  if (!isCoursePublic) {
    return null;
  }

  const storagePath = lesson.videoUrl || lesson.media?.[0]?.storagePath || null;
  if (!storagePath) {
    return null;
  }

  return {
    storagePath,
  };
}

async function sendMediaStoragePath(storagePath, req, res) {
  if (!storagePath) {
    throw new ApiError(404, "Video file not found");
  }

  const rangeHeader = String(req.get("range") || "").trim();
  if (rangeHeader) {
    res.setHeader("Accept-Ranges", "bytes");
  }
  res.setHeader(
    "Cache-Control",
    "private, no-store, no-cache, must-revalidate",
  );
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Disposition", "inline");

  if (isR2Enabled() && isR2StoragePath(storagePath)) {
    const object = await getObjectFromR2(storagePath, {
      range: rangeHeader || undefined,
    });
    if (!object.body) {
      throw new ApiError(404, "Video file not found");
    }
    if (object.acceptRanges) {
      res.setHeader("Accept-Ranges", object.acceptRanges);
    } else {
      res.setHeader("Accept-Ranges", "bytes");
    }
    res.setHeader("Content-Type", object.contentType);
    if (object.contentRange) {
      res.setHeader("Content-Range", object.contentRange);
    }
    if (object.contentLength) {
      res.setHeader("Content-Length", String(object.contentLength));
    }
    if (object.statusCode === 206 || object.contentRange) {
      res.status(206);
    }
    if (typeof object.body.pipe === "function") {
      object.body.pipe(res);
      return;
    }

    if (typeof object.body.transformToWebStream === "function") {
      Readable.fromWeb(object.body.transformToWebStream()).pipe(res);
      return;
    }

    if (typeof object.body.transformToByteArray === "function") {
      const bytes = await object.body.transformToByteArray();
      res.end(Buffer.from(bytes));
      return;
    }

    throw new ApiError(500, "Unsupported media stream format from storage");
  }

  if (/^https?:\/\//i.test(storagePath)) {
    const upstream = await fetch(storagePath, {
      headers: rangeHeader ? { Range: rangeHeader } : undefined,
    });
    if (!upstream.ok || !upstream.body) {
      throw new ApiError(404, "Video file not found");
    }

    const upstreamAcceptRanges = upstream.headers.get("accept-ranges");
    const upstreamContentType = upstream.headers.get("content-type");
    const upstreamContentLength = upstream.headers.get("content-length");
    const upstreamContentRange = upstream.headers.get("content-range");
    if (upstreamAcceptRanges) {
      res.setHeader("Accept-Ranges", upstreamAcceptRanges);
    } else if (rangeHeader) {
      res.setHeader("Accept-Ranges", "bytes");
    }
    if (upstreamContentType) {
      res.setHeader("Content-Type", upstreamContentType);
    }
    if (upstreamContentLength) {
      res.setHeader("Content-Length", upstreamContentLength);
    }
    if (upstreamContentRange) {
      res.setHeader("Content-Range", upstreamContentRange);
    }
    if (upstream.status === 206 || upstreamContentRange) {
      res.status(206);
    }

    Readable.fromWeb(upstream.body).pipe(res);
    return;
  }

  const absolutePath = path.resolve(storagePath.replace(/^\//, ""));
  res.sendFile(absolutePath);
}

function extractOriginFromHeader(value) {
  if (!value || value === "null") return "";
  try {
    return new URL(String(value)).origin;
  } catch (_error) {
    return "";
  }
}

function normalizeHostname(value) {
  const raw = String(value || "").toLowerCase();
  return raw.startsWith("www.") ? raw.slice(4) : raw;
}

function originsMatch(left, right) {
  const l = extractOriginFromHeader(left);
  const r = extractOriginFromHeader(right);
  if (!l || !r) return false;
  if (l === r) return true;

  try {
    const leftUrl = new URL(l);
    const rightUrl = new URL(r);
    return (
      leftUrl.protocol === rightUrl.protocol &&
      normalizeHostname(leftUrl.hostname) === normalizeHostname(rightUrl.hostname) &&
      leftUrl.port === rightUrl.port
    );
  } catch (_error) {
    return false;
  }
}

function getAllowedPlaybackOrigins() {
  const fromCors = String(env.corsOrigin || "")
    .split(",")
    .map((value) => extractOriginFromHeader(value.trim()))
    .filter(Boolean);
  const fromFrontend = extractOriginFromHeader(env.frontendUrl);
  return Array.from(
    new Set([fromFrontend, ...fromCors].filter(Boolean)),
  );
}

function assertPlaybackStreamRequest(req) {
  const fetchDest = String(req.get("sec-fetch-dest") || "").toLowerCase();
  const streamIntent = String(
    req.get("x-upskill-stream-intent") || "",
  ).toLowerCase();
  const isMediaFetchDest = fetchDest === "video" || fetchDest === "audio";

  if (!isMediaFetchDest && streamIntent !== "playback") {
    throw new ApiError(403, "Invalid stream context");
  }

  const allowedOrigins = getAllowedPlaybackOrigins();
  if (!allowedOrigins.length && String(env.corsOrigin || "").trim() !== "*") {
    throw new ApiError(500, "Playback origins are not configured");
  }

  const requestOrigin = extractOriginFromHeader(req.get("origin"));
  const refererOrigin = extractOriginFromHeader(req.get("referer"));
  const effectiveOrigin = requestOrigin || refererOrigin;

  if (!effectiveOrigin) {
    const authHeader = String(req.get("authorization") || "");
    if (/^bearer\s+\S+/i.test(authHeader)) {
      return;
    }
    throw new ApiError(403, "Untrusted stream origin");
  }

  if (String(env.corsOrigin || "").trim() === "*") {
    return;
  }

  const trusted = allowedOrigins.some((allowedOrigin) =>
    originsMatch(effectiveOrigin, allowedOrigin),
  );
  if (!trusted) {
    throw new ApiError(403, "Untrusted stream origin");
  }
}

function signStreamPlaybackToken({ userId, mediaId, roles = [] }) {
  return jwt.sign(
    {
      sub: String(userId),
      mediaId: String(mediaId),
      roles: Array.isArray(roles) ? roles : [],
      type: "stream-playback",
    },
    env.jwtAccessSecret,
    { expiresIn: "6h" },
  );
}

function verifyStreamPlaybackToken(token) {
  try {
    const payload = jwt.verify(String(token), env.jwtAccessSecret);
    if (payload?.type !== "stream-playback") {
      throw new ApiError(403, "Invalid stream token");
    }
    return payload;
  } catch (_error) {
    throw new ApiError(403, "Invalid or expired stream token");
  }
}

async function assertUserCanAccessMedia(user, mediaSource) {
  const userId =
    user && typeof user === "object" ? String(user.id || "") : String(user || "");
  const roleListRaw =
    user && typeof user === "object" ? user.roles : [];
  const roleList = Array.isArray(roleListRaw)
    ? roleListRaw.map((role) => String(role || "").toUpperCase())
    : [];

  if (roleList.includes("ADMIN")) {
    return;
  }

  if (mediaSource.courseId) {
    const [ownedCourse, enrollment] = await Promise.all([
      prisma.course.findFirst({
        where: {
          id: mediaSource.courseId,
          educatorId: userId,
          deletedAt: null,
        },
        select: { id: true },
      }),
      prisma.enrollment.findFirst({
        where: {
          userId,
          courseId: mediaSource.courseId,
          status: "ACTIVE",
        },
        select: { id: true, courseId: true },
      }),
    ]);

    if (!ownedCourse && !enrollment) {
      throw new ApiError(403, "Not allowed to access this media");
    }

    if (mediaSource.lessonId && enrollment) {
      await assertLessonUnlockedForEnrollment(
        enrollment.id,
        enrollment.courseId,
        mediaSource.lessonId,
      );
    }
    return;
  }

  if (mediaSource.userId && mediaSource.userId !== userId) {
    throw new ApiError(403, "Not allowed to access this media");
  }
}

router.get("/user/:slug", async (req, res, next) => {
  try {
    const user = await prisma.user.findFirst({
      where: {
        username: req.params.slug,
        deletedAt: null,
      },
      include: {
        roles: {
          include: { role: true },
        },
      },
    });

    if (!user) {
      throw new ApiError(404, "User not found");
    }

    const extended = normalizeExtendedProfile(user);
    const roleNames = user.roles.map((item) =>
      String(item?.role?.name || "").toUpperCase(),
    );
    const isEducator = roleNames.includes("EDUCATOR");
    const isLearner = roleNames.includes("LEARNER");

    const [
      educatorStatsRaw,
      completedEnrollmentsRaw,
      certificateIndexRows,
      userPicture,
    ] = await Promise.all([
      isEducator
        ? Promise.all([
            prisma.course.count({
              where: {
                educatorId: user.id,
                workflowStatus: "PUBLISHED",
                deletedAt: null,
              },
            }),
            prisma.enrollment.count({
              where: {
                course: {
                  educatorId: user.id,
                  deletedAt: null,
                },
                status: { in: ["ACTIVE", "COMPLETED"] },
              },
            }),
            prisma.review.count({
              where: {
                course: {
                  educatorId: user.id,
                  deletedAt: null,
                },
              },
            }),
            prisma.review.aggregate({
              where: {
                course: {
                  educatorId: user.id,
                  deletedAt: null,
                },
              },
              _avg: { rating: true },
            }),
          ])
        : Promise.resolve([0, 0, 0, { _avg: { rating: 0 } }]),
      isLearner
        ? prisma.enrollment.findMany({
            where: {
              userId: user.id,
              status: { in: ["ACTIVE", "COMPLETED"] },
              course: { deletedAt: null },
            },
            select: {
              id: true,
              completedAt: true,
              status: true,
              course: {
                select: {
                  id: true,
                  slug: true,
                  title: true,
                  _count: {
                    select: {
                      reviews: true,
                    },
                  },
                  educator: {
                    select: {
                      firstName: true,
                      lastName: true,
                      username: true,
                    },
                  },
                  media: {
                    where: {
                      mediaType: { in: ["COVER_IMAGE", "IMAGE"] },
                    },
                    orderBy: { createdAt: "desc" },
                  },
                },
              },
              courseProgress: {
                select: {
                  progressPct: true,
                  completedAt: true,
                },
              },
            },
            orderBy: { updatedAt: "desc" },
          })
        : Promise.resolve([]),
      isLearner
        ? prisma.platformSetting.findMany({
            where: {
              key: { startsWith: `certificate_index::${user.id}::` },
            },
            select: {
              key: true,
              value: true,
              createdAt: true,
            },
            orderBy: { createdAt: "desc" },
          })
        : Promise.resolve([]),
      (async () => {
        const setting = await prisma.platformSetting.findUnique({
          where: { key: getUserPictureSettingKey(user.id) },
          select: { value: true },
        });

        const parsed = parseJsonOrNull(setting?.value);
        const mediaId = String(
          parsed?.mediaId || parsed?.id || setting?.value || "",
        ).trim();
        if (!mediaId) return null;

        const media = await prisma.media.findFirst({
          where: {
            id: mediaId,
            userId: user.id,
            mediaType: "IMAGE",
          },
          select: {
            id: true,
            storagePath: true,
            originalName: true,
          },
        });

        if (!media) return null;
        return {
          id: media.id,
          path: media.storagePath,
          title: media.originalName || "",
        };
      })(),
    ]);

    const educatorStats = {
      published_courses: Number(educatorStatsRaw?.[0] || 0),
      total_learners: Number(educatorStatsRaw?.[1] || 0),
      total_reviews: Number(educatorStatsRaw?.[2] || 0),
      average_rating: Number(educatorStatsRaw?.[3]?._avg?.rating || 0),
    };

    const completed_courses = (completedEnrollmentsRaw || [])
      .filter((row) => {
        const progressPct = Number(row?.courseProgress?.progressPct || 0);
        return (
          String(row?.status || "").toUpperCase() === "COMPLETED" ||
          progressPct >= 100 ||
          Boolean(row?.completedAt || row?.courseProgress?.completedAt)
        );
      })
      .map((row) => ({
        cover_image: mapLegacyMedia(
          pickLatestMediaByTypes(row?.course?.media, ["COVER_IMAGE", "IMAGE"]),
        ),
        enrollment_id: row.id,
        course_id: row?.course?.id || null,
        course_slug: row?.course?.slug || null,
        course_title: row?.course?.title || "Course",
        reviews_count: Number(row?.course?._count?.reviews || 0),
        instructor_name:
          `${row?.course?.educator?.firstName || ""} ${row?.course?.educator?.lastName || ""}`.trim() ||
          row?.course?.educator?.username ||
          "Instructor",
        completed_at:
          row?.completedAt || row?.courseProgress?.completedAt || null,
      }));

    const certificateIndexPayloads = (certificateIndexRows || [])
      .map((row) => parseJsonOrNull(row?.value))
      .filter((row) => row?.slug);
    const certificateSlugs = Array.from(
      new Set(
        certificateIndexPayloads
          .map((row) => String(row.slug || "").trim())
          .filter(Boolean),
      ),
    );
    const certificateRows = certificateSlugs.length
      ? await prisma.platformSetting.findMany({
          where: {
            key: {
              in: certificateSlugs.map((slug) => `certificate::${slug}`),
            },
          },
          select: {
            key: true,
            value: true,
          },
        })
      : [];
    const certificatePayloadBySlug = new Map(
      certificateRows
        .map((row) => [
          String(row.key || "").replace("certificate::", ""),
          parseJsonOrNull(row.value),
        ])
        .filter(([, value]) => value),
    );

    const certifications = certificateSlugs
      .map((slug) => {
        const cert = certificatePayloadBySlug.get(slug);
        if (!cert) return null;
        return {
          slug,
          certification_no: cert.certificationNo || null,
          reference_no: cert.referenceNo || null,
          course_title: cert.courseTitle || "Course",
          issued_at: cert.issuedAt || null,
          certification_url:
            cert.certificationUrl ||
            `${env.frontendUrl.replace(/\/+$/, "")}/certifications/${slug}`,
        };
      })
      .filter(Boolean)
      .sort(
        (a, b) =>
          new Date(b.issued_at || 0).getTime() -
          new Date(a.issued_at || 0).getTime(),
      );

    return res.json({
      id: user.id,
      username: user.username,
      email: user.email,
      firstname: user.firstName || "",
      lastname: user.lastName || "",
      firstName: user.firstName || "",
      lastName: user.lastName || "",
      biography: extended.biography,
      headline: extended.headline,
      link_website: extended.link_website,
      link_facebook: extended.link_facebook,
      link_instagram: extended.link_instagram,
      link_linkedin: extended.link_linkedin,
      link_tiktok: extended.link_tiktok,
      link_x: extended.link_x,
      link_youtube: extended.link_youtube,
      link_github: extended.link_github,
      user_picture: userPicture,
      roles: user.roles.map((item) => ({
        role_name:
          item.role.name === "EDUCATOR"
            ? "Instructor"
            : item.role.name === "LEARNER"
              ? "Learner"
              : item.role.name,
      })),
      stats: {
        educator: educatorStats,
        learner: {
          completed_courses_count: completed_courses.length,
          certifications_count: certifications.length,
        },
      },
      completed_courses,
      certifications,
    });
  } catch (error) {
    return next(error);
  }
});

router.get("/instructor/courses/:userId", async (req, res, next) => {
  try {
    const courses = await prisma.course.findMany({
      where: {
        educatorId: req.params.userId,
        workflowStatus: "PUBLISHED",
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
          },
        },
        level: true,
        priceTier: true,
        media: {
          where: {
            mediaType: { in: ["COVER_IMAGE", "IMAGE", "PROMO_VIDEO"] },
          },
          orderBy: { createdAt: "desc" },
        },
        _count: {
          select: {
            reviews: true,
          },
        },
        sections: { include: { lessons: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    const educatorIds = Array.from(
      new Set(courses.map((course) => course?.educator?.id).filter(Boolean)),
    );
    const educatorPicturesByUserId = new Map();

    if (educatorIds.length) {
      const mediaRows = await prisma.media.findMany({
        where: {
          userId: { in: educatorIds },
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

      for (const mediaRow of mediaRows) {
        if (!educatorPicturesByUserId.has(mediaRow.userId)) {
          educatorPicturesByUserId.set(mediaRow.userId, {
            id: mediaRow.id,
            path: mediaRow.storagePath,
            title: mediaRow.originalName || "",
          });
        }
      }
    }
    const courseIds = courses.map((course) => course.id);
    const ratingsByCourseId = new Map();

    if (courseIds.length) {
      const ratingAggregates = await prisma.review.groupBy({
        by: ["courseId"],
        where: { courseId: { in: courseIds } },
        _avg: { rating: true },
      });

      for (const row of ratingAggregates) {
        ratingsByCourseId.set(row.courseId, Number(row?._avg?.rating || 0));
      }
    }

    const data = courses.map((course) => ({
      ...course,
      uuid: course.id,
      cover_image: mapLegacyMedia(
        pickLatestMediaByTypes(course.media, ["COVER_IMAGE", "IMAGE"]),
      ),
      promo_video: mapLegacyMedia(
        pickLatestMediaByTypes(course.media, ["PROMO_VIDEO"]),
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
      author: {
        data: {
          id: course.educator.id,
          username: course.educator.username,
          firstname: course.educator.firstName || "",
          lastname: course.educator.lastName || "",
          headline: course.educator.headline || "",
          user_picture:
            educatorPicturesByUserId.get(course.educator.id) || null,
        },
      },
      resources_count: {
        section_count: course.sections.length,
        curriculum_count: course.sections.reduce(
          (acc, section) => acc + section.lessons.length,
          0,
        ),
      },
      stats: {
        average_rating: ratingsByCourseId.get(course.id) || 0,
        total_reviews: Number(course?._count?.reviews || 0),
      },
    }));

    return res.json({ data });
  } catch (error) {
    return next(error);
  }
});

router.put("/profile", authenticate, async (req, res, next) => {
  try {
    const updatedUser = await prisma.user.update({
      where: { id: req.user.id },
      data: {
        firstName:
          req.body.firstName === undefined
            ? req.body.firstname
            : req.body.firstName,
        lastName:
          req.body.lastName === undefined
            ? req.body.lastname
            : req.body.lastName,
        headline:
          req.body.headline === undefined ? undefined : req.body.headline,
        biography:
          req.body.biography === undefined ? undefined : req.body.biography,
        link_website:
          req.body.link_website === undefined
            ? undefined
            : req.body.link_website,
        link_facebook:
          req.body.link_facebook === undefined
            ? undefined
            : req.body.link_facebook,
        link_instagram:
          req.body.link_instagram === undefined
            ? undefined
            : req.body.link_instagram,
        link_linkedin:
          req.body.link_linkedin === undefined
            ? undefined
            : req.body.link_linkedin,
        link_tiktok:
          req.body.link_tiktok === undefined ? undefined : req.body.link_tiktok,
        link_x: req.body.link_x === undefined ? undefined : req.body.link_x,
        link_youtube:
          req.body.link_youtube === undefined
            ? undefined
            : req.body.link_youtube,
        link_github:
          req.body.link_github === undefined ? undefined : req.body.link_github,
      },
    });

    const extended = normalizeExtendedProfile(updatedUser);
    await recordActivityEvent({
      eventType: "ACCOUNT_PROFILE_UPDATED",
      userId: req.user.id,
      pagePath: "/profile/basic-information",
      metadata: { source: "legacy-profile-route" },
      dedupeWindowSeconds: 5,
    });
    return res.json({
      message: "Profile updated",
      data: {
        id: updatedUser.id,
        firstname: updatedUser.firstName || "",
        lastname: updatedUser.lastName || "",
        firstName: updatedUser.firstName || "",
        lastName: updatedUser.lastName || "",
        ...extended,
      },
    });
  } catch (error) {
    return next(error);
  }
});

router.put("/profile/user-picture", authenticate, async (req, res, next) => {
  try {
    const mediaId = req.body.user_picture
      ? String(req.body.user_picture)
      : null;
    if (!mediaId) {
      throw new ApiError(400, "user_picture is required");
    }

    const media = await prisma.media.findFirst({
      where: {
        id: mediaId,
        userId: req.user.id,
      },
      select: {
        id: true,
        storagePath: true,
      },
    });

    if (!media) {
      throw new ApiError(404, "Media not found");
    }

    await prisma.platformSetting.upsert({
      where: { key: getUserPictureSettingKey(req.user.id) },
      create: {
        key: getUserPictureSettingKey(req.user.id),
        value: JSON.stringify({ mediaId: media.id }),
        description: `Profile picture for user ${req.user.id}`,
      },
      update: {
        value: JSON.stringify({ mediaId: media.id }),
        description: `Profile picture for user ${req.user.id}`,
      },
    });

    return res.json({
      message: "Profile image linked",
      data: { id: media.id, path: media.storagePath },
    });
  } catch (error) {
    return next(error);
  }
});

router.post(
  "/media",
  authenticate,
  upload.single("file"),
  async (req, res, next) => {
    try {
      if (!req.file) {
        throw new ApiError(400, "File is required");
      }

      const media = await prisma.media.create({
        data: {
          userId: req.user.id,
          storagePath: mediaPath(req.file),
          originalName: req.file.originalname,
          mimeType: req.file.mimetype,
          mediaType: "IMAGE",
          sizeInBytes: req.file.size,
        },
      });
      return res.status(201).json({
        id: media.id,
        path: media.storagePath,
        title: media.originalName,
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  "/videos",
  authenticate,
  upload.single("file"),
  async (req, res, next) => {
    try {
      if (!req.file) {
        throw new ApiError(400, "File is required");
      }

      const media = await prisma.media.create({
        data: {
          userId: req.user.id,
          storagePath: mediaPath(req.file),
          originalName: req.file.originalname,
          mimeType: req.file.mimetype,
          mediaType: "VIDEO",
          sizeInBytes: req.file.size,
        },
      });
      return res.status(201).json({
        id: media.id,
        path: media.storagePath,
        title: media.originalName,
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  "/courses/:courseId/promo-video",
  authenticate,
  authorize("EDUCATOR"),
  upload.single("promo_video"),
  async (req, res, next) => {
    try {
      const courseId = req.params.courseId;
      await ensureEducatorOwnsCourse(req.user.id, courseId);

      if (!req.file) {
        throw new ApiError(400, "File is required");
      }

      const media = await prisma.media.create({
        data: {
          userId: req.user.id,
          courseId,
          storagePath: mediaPath(req.file),
          originalName: req.file.originalname,
          mimeType: req.file.mimetype,
          mediaType: "PROMO_VIDEO",
          sizeInBytes: req.file.size,
        },
      });

      return res.status(201).json({
        id: media.id,
        path: media.storagePath,
        title: media.originalName,
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.get(
  "/course-sections/course/:courseId",
  authenticate,
  authorize("EDUCATOR"),
  async (req, res, next) => {
    try {
      await ensureEducatorOwnsCourse(req.user.id, req.params.courseId);
      const sections = await prisma.courseSection.findMany({
        where: { courseId: req.params.courseId },
        orderBy: { position: "asc" },
      });
      return res.json(
        sections.map((section) => ({
          ...section,
          section_description: section.description || "",
        })),
      );
    } catch (error) {
      return next(error);
    }
  },
);

router.get(
  "/course-sections/course/:courseId/topics",
  authenticate,
  authorize("EDUCATOR"),
  async (req, res, next) => {
    try {
      const course = await ensureEducatorOwnsCourse(
        req.user.id,
        req.params.courseId,
      );
      if (!course.categoryId) {
        return res.json({ data: [] });
      }

      const topics = await prisma.topic.findMany({
        where: {
          deletedAt: null,
          category: {
            deletedAt: null,
            OR: [{ id: course.categoryId }, { parentId: course.categoryId }],
          },
        },
        include: {
          category: {
            select: {
              id: true,
              name: true,
              parentId: true,
              parent: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          },
        },
        orderBy: [{ category: { name: "asc" } }, { name: "asc" }],
      });

      return res.json({
        data: topics.map((topic) => ({
          id: topic.id,
          title: topic.name,
          slug: topic.slug,
          category_id: topic.categoryId,
          category_title: topic.category?.name || "",
          parent_category_id: topic.category?.parentId || null,
          parent_category_title: topic.category?.parent?.name || null,
        })),
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  "/course-sections",
  authenticate,
  authorize("EDUCATOR"),
  async (req, res, next) => {
    try {
      const courseId = req.body.course_id;
      await ensureEducatorOwnsCourse(req.user.id, courseId);

      const lastSection = await prisma.courseSection.findFirst({
        where: { courseId },
        orderBy: { position: "desc" },
      });

      const section = await prisma.courseSection.create({
        data: {
          courseId,
          title: req.body.title,
          description: req.body.description || "",
          position: (lastSection?.position || 0) + 1,
        },
      });

      return res.status(201).json({
        data: {
          ...section,
          section_description: section.description || "",
        },
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.put(
  "/course-sections/:sectionId",
  authenticate,
  authorize("EDUCATOR"),
  async (req, res, next) => {
    try {
      const section = await ensureEducatorOwnsSection(
        req.user.id,
        req.params.sectionId,
      );

      const updated = await prisma.courseSection.update({
        where: { id: section.id },
        data: {
          title: req.body.title,
          description: req.body.description || "",
        },
      });

      return res.json({
        data: {
          ...updated,
          section_description: updated.description || "",
        },
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.delete(
  "/course-sections/:sectionId",
  authenticate,
  authorize("EDUCATOR"),
  async (req, res, next) => {
    try {
      const section = await ensureEducatorOwnsSection(
        req.user.id,
        req.params.sectionId,
      );
      await prisma.courseSection.delete({ where: { id: section.id } });
      return res.json({ success: true });
    } catch (error) {
      return next(error);
    }
  },
);

router.get(
  "/course-sections/:sectionId/curriculums",
  authenticate,
  authorize("EDUCATOR"),
  async (req, res, next) => {
    try {
      const section = await ensureEducatorOwnsSection(
        req.user.id,
        req.params.sectionId,
      );
      const lessons = await prisma.lesson.findMany({
        where: { sectionId: section.id },
        include: lessonIncludeForTopics(),
        orderBy: { position: "asc" },
      });
      return res.json({
        data: lessons.map(mapLessonToLegacyCurriculum),
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.put(
  "/course-sections/:sectionId/curriculums/sort",
  authenticate,
  authorize("EDUCATOR"),
  async (req, res, next) => {
    try {
      const section = await ensureEducatorOwnsSection(
        req.user.id,
        req.params.sectionId,
      );
      const itemIds = Array.isArray(req.body.items) ? req.body.items : [];
      await prisma.$transaction(
        itemIds.map((id, index) =>
          prisma.lesson.updateMany({
            where: { id, sectionId: section.id },
            data: { position: index + 1 },
          }),
        ),
      );
      return res.json({ success: true });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  "/course-curriculums",
  authenticate,
  authorize("EDUCATOR"),
  async (req, res, next) => {
    try {
      const section = await ensureEducatorOwnsSection(
        req.user.id,
        req.body.course_section_id,
      );
      const topicIds = extractTopicIdsFromRequestBody(req.body) || [];
      const topics = await resolveCurriculumTopicsForCourse(
        section.course,
        topicIds,
      );
      const unlockRule = extractLessonUnlockRuleFromBody(req.body);
      if (
        unlockRule.unlockType === "AFTER_CUSTOM" &&
        unlockRule.prerequisiteLessonId
      ) {
        const prerequisite = await prisma.lesson.findFirst({
          where: {
            id: unlockRule.prerequisiteLessonId,
            courseId: section.courseId,
          },
          select: { id: true },
        });
        if (!prerequisite) {
          throw new ApiError(
            400,
            "Prerequisite lesson must belong to the same course",
          );
        }
      }
      const lesson = await prisma.lesson.create({
        include: lessonIncludeForTopics(),
        data: {
          sectionId: section.id,
          courseId: section.courseId,
          topicId: topics[0]?.id || null,
          ...(supportsLessonTopics && topics.length > 0
            ? {
                lessonTopics: {
                  create: topics.map((topic) => ({
                    topicId: topic.id,
                  })),
                },
              }
            : {}),
          type:
            req.body.curriculum_type === "quiz"
              ? "QUIZ"
              : req.body.curriculum_type === "coding_exercise"
                ? "CODING_EXERCISE"
                : req.body.curriculum_type === "assignment"
                  ? "ASSIGNMENT"
                  : "RESOURCE",
          title: req.body.title,
          description: req.body.description || "",
          isPreview:
            req.body.is_public_preview === true ||
            req.body.is_public_preview === "1" ||
            req.body.is_preview === true ||
            req.body.is_preview === "1" ||
            req.body.published === true ||
            req.body.published === "1",
          position:
            ((
              await prisma.lesson.findFirst({
                where: { sectionId: section.id },
                orderBy: { position: "desc" },
              })
            )?.position || 0) + 1,
          unlockType: unlockRule.unlockType,
          unlockAt: unlockRule.unlockAt,
          prerequisiteLessonId: unlockRule.prerequisiteLessonId,
        },
      });

      return res
        .status(201)
        .json({ data: mapLessonToLegacyCurriculum(lesson) });
    } catch (error) {
      return next(error);
    }
  },
);

router.put(
  "/course-curriculums/:lessonId",
  authenticate,
  authorize("EDUCATOR"),
  async (req, res, next) => {
    try {
      const lesson = await ensureEducatorOwnsLesson(
        req.user.id,
        req.params.lessonId,
      );
      const quizQuestions =
        req.body.quizQuestions !== undefined
          ? req.body.quizQuestions
          : req.body.quiz_questions;
      const codingInstructions =
        req.body.codingInstructions !== undefined
          ? req.body.codingInstructions
          : req.body.coding_instructions;
      const codingStarterCode =
        req.body.codingStarterCode !== undefined
          ? req.body.codingStarterCode
          : req.body.coding_starter_code;
      const topicIds = extractTopicIdsFromRequestBody(req.body);

      const data = {
        title: req.body.title,
        description: req.body.description || "",
      };
      const hasUnlockRuleUpdate =
        req.body.unlock_type !== undefined ||
        req.body.unlockType !== undefined ||
        req.body.unlock_at !== undefined ||
        req.body.unlockAt !== undefined ||
        req.body.prerequisite_lesson_id !== undefined ||
        req.body.prerequisiteLessonId !== undefined;
      if (hasUnlockRuleUpdate) {
        const unlockRule = extractLessonUnlockRuleFromBody(req.body);
        if (
          unlockRule.unlockType === "AFTER_CUSTOM" &&
          unlockRule.prerequisiteLessonId
        ) {
          if (unlockRule.prerequisiteLessonId === lesson.id) {
            throw new ApiError(400, "A lesson cannot depend on itself");
          }
          const prerequisite = await prisma.lesson.findFirst({
            where: {
              id: unlockRule.prerequisiteLessonId,
              courseId: lesson.courseId,
            },
            select: { id: true },
          });
          if (!prerequisite) {
            throw new ApiError(
              400,
              "Prerequisite lesson must belong to the same course",
            );
          }
        }
        data.unlockType = unlockRule.unlockType;
        data.unlockAt = unlockRule.unlockAt;
        data.prerequisiteLessonId = unlockRule.prerequisiteLessonId;
      }

      if (
        req.body.is_public_preview !== undefined ||
        req.body.is_preview !== undefined ||
        req.body.published !== undefined
      ) {
        data.isPreview =
          req.body.is_public_preview === true ||
          req.body.is_public_preview === "1" ||
          req.body.is_preview === true ||
          req.body.is_preview === "1" ||
          req.body.published === true ||
          req.body.published === "1";
      }

      if (quizQuestions !== undefined) {
        data.quizQuestions = quizQuestions;
      }

      if (codingInstructions !== undefined) {
        data.codingInstructions = String(codingInstructions || "");
      }

      if (codingStarterCode !== undefined) {
        data.codingStarterCode =
          typeof codingStarterCode === "string"
            ? codingStarterCode
            : JSON.stringify(codingStarterCode || {});
      }

      if (topicIds !== undefined) {
        const topics = await resolveCurriculumTopicsForCourse(
          lesson.course,
          topicIds,
        );
        data.topicId = topics[0]?.id || null;

        if (!supportsLessonTopics) {
          if (topics.length > 1) {
            throw new ApiError(
              400,
              "Multiple topics require the latest migration and Prisma client generation",
            );
          }
          const updated = await prisma.lesson.update({
            where: { id: lesson.id },
            data,
            include: lessonIncludeForTopics(),
          });
          return res.json({ data: mapLessonToLegacyCurriculum(updated) });
        }

        const updated = await prisma.$transaction(async (tx) => {
          await tx.lesson.update({
            where: { id: lesson.id },
            data,
          });
          await tx.lessonTopic.deleteMany({
            where: { lessonId: lesson.id },
          });
          if (topics.length > 0) {
            await tx.lessonTopic.createMany({
              data: topics.map((topic) => ({
                lessonId: lesson.id,
                topicId: topic.id,
              })),
            });
          }
          return tx.lesson.findUnique({
            where: { id: lesson.id },
            include: lessonIncludeForTopics(),
          });
        });
        return res.json({ data: mapLessonToLegacyCurriculum(updated) });
      }

      const updated = await prisma.lesson.update({
        where: { id: lesson.id },
        data,
        include: lessonIncludeForTopics(),
      });
      return res.json({ data: mapLessonToLegacyCurriculum(updated) });
    } catch (error) {
      return next(error);
    }
  },
);

router.delete(
  "/course-curriculums/:lessonId",
  authenticate,
  authorize("EDUCATOR"),
  async (req, res, next) => {
    try {
      const lesson = await ensureEducatorOwnsLesson(
        req.user.id,
        req.params.lessonId,
      );
      await prisma.lesson.delete({ where: { id: lesson.id } });
      return res.json({ success: true });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  "/course-curriculums/add-progress",
  authenticate,
  async (req, res, next) => {
    try {
      await assertLessonUnlockedForUser(req.user.id, req.body.curriculum_id);
      const data = await updateLessonProgress(req.user.id, {
        lessonId: req.body.curriculum_id,
        progressPct: 100,
        isCompleted: true,
        lastPosition: 0,
      });
      return res.json({ data });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  "/course-curriculums/:lessonId/coding-submissions",
  authenticate,
  authorize("LEARNER"),
  async (req, res, next) => {
    try {
      const { lesson } = await ensureLearnerOwnsCodingLesson(
        req.user.id,
        req.params.lessonId,
      );
      await assertLessonUnlockedForUser(req.user.id, lesson.id);
      const language = String(req.body.language || "")
        .trim()
        .toLowerCase();
      const sourceCode = String(req.body.sourceCode || "");
      const mode =
        String(req.body.mode || "RUN").toUpperCase() === "SUBMIT"
          ? "SUBMIT"
          : "RUN";

      if (!language || !JUDGE0_LANGUAGE_IDS[language]) {
        throw new ApiError(400, "Unsupported coding language");
      }
      if (!sourceCode.trim()) {
        throw new ApiError(400, "Source code is required");
      }

      const submissionId = randomUUID();
      codingSubmissionStore.set(submissionId, {
        id: submissionId,
        lessonId: lesson.id,
        userId: req.user.id,
        language,
        sourceCode,
        mode,
        status: "QUEUED",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        summary: null,
        error: null,
      });

      setTimeout(() => {
        processCodingSubmission(submissionId).catch(() => {});
      }, 0);

      return res.status(202).json({
        data: {
          submissionId,
          status: "QUEUED",
        },
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  "/course-curriculums/:lessonId/coding-step-check",
  authenticate,
  authorize("LEARNER"),
  async (req, res, next) => {
    try {
      const { lesson } = await ensureLearnerOwnsCodingLesson(
        req.user.id,
        req.params.lessonId,
      );
      await assertLessonUnlockedForUser(req.user.id, lesson.id);
      const language = String(req.body.language || "")
        .trim()
        .toLowerCase();
      const sourceCode = String(req.body.sourceCode || "");
      const requestedStepNumber = Number(req.body.stepNumber || 1);

      if (!language) {
        throw new ApiError(400, "Language is required");
      }
      if (!sourceCode.trim()) {
        throw new ApiError(400, "Source code is required");
      }
      if (!Number.isFinite(requestedStepNumber) || requestedStepNumber < 1) {
        throw new ApiError(400, "Valid step number is required");
      }

      const asset = normalizeCodingAsset(lesson.codingStarterCode);
      const steps = normalizeCodingStepsForLanguage(asset, language);
      if (!steps.length) {
        throw new ApiError(
          400,
          "No step challenges configured for this language",
        );
      }

      const activeStep = steps.find(
        (item) => item.stepNumber === requestedStepNumber,
      );
      if (!activeStep) {
        throw new ApiError(404, "Step challenge not found");
      }

      const results = [];
      for (const validator of activeStep.validators) {
        if (validator.mode === "RUN_OUTPUT") {
          if (!JUDGE0_LANGUAGE_IDS[language]) {
            throw new ApiError(
              400,
              `RUN_OUTPUT validation is not supported for ${language}. Use CODE_INCLUDES or EXACT_CODE.`,
            );
          }
          const run = await executeJudge0Code({
            language,
            sourceCode,
            stdin: validator.input,
          });
          const passed =
            !run.hasExecutionError &&
            compareCodingOutput(
              run.actualOutput,
              validator.expectedOutput,
              validator.comparisonMode,
            );
          results.push({
            id: validator.id,
            name: validator.name,
            mode: validator.mode,
            visibility: validator.visibility,
            expectedOutput: validator.expectedOutput,
            actualOutput: run.actualOutput,
            passed,
            stderr: run.stderr,
            compileOutput: run.compileOutput,
            statusDescription: run.statusDescription,
          });
        } else {
          const passed = compareCodingSource(
            sourceCode,
            validator.expectedOutput,
            validator.mode,
            validator.comparisonMode,
          );
          results.push({
            id: validator.id,
            name: validator.name,
            mode: validator.mode,
            visibility: validator.visibility,
            expectedOutput: validator.expectedOutput,
            actualOutput: sourceCode,
            passed,
            stderr: "",
            compileOutput: "",
            statusDescription: passed ? "Matched source" : "Source mismatch",
          });
        }
      }

      const allPassed = results.every((item) => item.passed);
      const currentStepIndex = steps.findIndex(
        (item) => item.stepNumber === activeStep.stepNumber,
      );
      const nextStep = allPassed
        ? steps[currentStepIndex + 1] || null
        : activeStep;
      const isFinalStep = currentStepIndex === steps.length - 1;
      const lessonCompleted = allPassed && isFinalStep;

      if (lessonCompleted) {
        await updateLessonProgress(req.user.id, {
          lessonId: lesson.id,
          progressPct: 100,
          isCompleted: true,
          lastPosition: 0,
        });
      }

      const visibleResults = results
        .filter((item) => item.visibility === "VISIBLE")
        .map((item) => ({
          id: item.id,
          name: item.name,
          mode: item.mode,
          expectedOutput: item.expectedOutput,
          actualOutput: item.actualOutput,
          passed: item.passed,
          statusDescription: item.statusDescription,
        }));
      const hiddenResults = results.filter(
        (item) => item.visibility === "HIDDEN",
      );

      return res.json({
        data: {
          lessonId: lesson.id,
          language,
          step: {
            id: activeStep.id,
            stepNumber: activeStep.stepNumber,
            title: activeStep.title,
            instruction: activeStep.instruction,
          },
          summary: {
            allPassed,
            totalChecks: results.length,
            passedChecks: results.filter((item) => item.passed).length,
            visibleResults,
            hiddenSummary: {
              total: hiddenResults.length,
              passed: hiddenResults.filter((item) => item.passed).length,
            },
          },
          next: nextStep
            ? {
                stepNumber: nextStep.stepNumber,
                title: nextStep.title,
                instruction: nextStep.instruction,
                starterCode: nextStep.starterCode,
              }
            : null,
          lessonCompleted,
        },
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  "/course-curriculums/:lessonId/coding-submit",
  authenticate,
  authorize("LEARNER"),
  async (req, res, next) => {
    try {
      const { lesson } = await ensureLearnerOwnsCodingLesson(
        req.user.id,
        req.params.lessonId,
      );
      await assertLessonUnlockedForUser(req.user.id, lesson.id);
      const language = String(req.body.language || "")
        .trim()
        .toLowerCase();
      const sourceCode = String(req.body.sourceCode || "");
      const action = String(
        req.body.action || req.body.mode || "submit",
      ).toUpperCase();

      if (!language) {
        throw new ApiError(400, "Language is required");
      }
      if (!sourceCode.trim()) {
        throw new ApiError(400, "Source code is required");
      }

      const submissionId = randomUUID();
      const now = new Date().toISOString();
      const submission = {
        id: submissionId,
        userId: req.user.id,
        lessonId: req.params.lessonId,
        language,
        sourceCode,
        mode: action === "RUN" ? "RUN" : "SUBMIT",
        status: "QUEUED",
        summary: null,
        error: null,
        createdAt: now,
        updatedAt: now,
      };

      codingSubmissionStore.set(submissionId, submission);
      // Start processing asynchronously
      setImmediate(() => {
        try {
          processCodingSubmission(submissionId);
        } catch (_err) {
          // swallow - processCodingSubmission handles its own errors
        }
      });

      return res
        .status(202)
        .json({ data: { submissionId, status: submission.status } });
    } catch (error) {
      return next(error);
    }
  },
);

router.get(
  "/course-curriculums/:lessonId/coding-submissions/:submissionId",
  authenticate,
  authorize("LEARNER"),
  async (req, res, next) => {
    try {
      await ensureLearnerOwnsCodingLesson(req.user.id, req.params.lessonId);
      await assertLessonUnlockedForUser(req.user.id, req.params.lessonId);
      const submission = getCodingSubmissionStatus(req.params.submissionId);
      if (
        submission.userId !== req.user.id ||
        submission.lessonId !== req.params.lessonId
      ) {
        throw new ApiError(403, "Not allowed to view this submission");
      }

      return res.json({
        data: {
          submissionId: submission.id,
          status: submission.status,
          mode: submission.mode,
          language: submission.language,
          summary: submission.summary,
          error: submission.error,
          createdAt: submission.createdAt,
          updatedAt: submission.updatedAt,
        },
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.get(
  "/course-curriculums/:lessonId/quiz-attempt",
  authenticate,
  authorize("LEARNER"),
  async (req, res, next) => {
    try {
      const { lesson } = await ensureLearnerOwnsQuizLesson(
        req.user.id,
        req.params.lessonId,
      );
      await assertLessonUnlockedForUser(req.user.id, lesson.id);
      const { key, quizPayload, state } = await loadQuizAttemptState(
        req.user.id,
        lesson,
      );
      await saveQuizAttemptState(key, state);

      return res.json({
        data: {
          lessonId: lesson.id,
          settings: quizPayload.settings,
          totalQuestions: quizPayload.questions.length,
          state,
        },
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  "/course-curriculums/:lessonId/quiz-attempt/hint",
  authenticate,
  authorize("LEARNER"),
  async (req, res, next) => {
    try {
      const questionIndex = Number(req.body.questionIndex);
      if (!Number.isInteger(questionIndex) || questionIndex < 0) {
        throw new ApiError(400, "Invalid questionIndex");
      }

      const { lesson } = await ensureLearnerOwnsQuizLesson(
        req.user.id,
        req.params.lessonId,
      );
      await assertLessonUnlockedForUser(req.user.id, lesson.id);
      const { key, quizPayload, state } = await loadQuizAttemptState(
        req.user.id,
        lesson,
      );
      const question = quizPayload.questions[questionIndex];
      if (!question) {
        throw new ApiError(404, "Question not found");
      }
      if (state.completed) {
        throw new ApiError(400, "Quiz already completed");
      }

      const questionKey = question.id || `q-${questionIndex + 1}`;
      const alreadyUsed = Boolean(state.hintUsage?.[questionKey]);
      if (!alreadyUsed) {
        state.hintUsage = state.hintUsage || {};
        state.hintUsage[questionKey] = true;
        state.lastActivityAt = new Date().toISOString();
        state.metrics = computeQuizMetrics(
          state,
          quizPayload.questions.length,
          quizPayload.settings.passingScore,
        );
        await saveQuizAttemptState(key, state);
      }

      return res.json({
        data: {
          questionIndex,
          hint: buildQuizAnswerRevealHint(question) || resolveQuizHintText(question),
          alreadyUsed,
          hintUsed: true,
        },
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  "/course-curriculums/:lessonId/quiz-attempt/validate",
  authenticate,
  authorize("LEARNER"),
  async (req, res, next) => {
    try {
      const questionIndex = Number(req.body.questionIndex);
      if (!Number.isInteger(questionIndex) || questionIndex < 0) {
        throw new ApiError(400, "Invalid questionIndex");
      }

      const { lesson } = await ensureLearnerOwnsQuizLesson(
        req.user.id,
        req.params.lessonId,
      );
      await assertLessonUnlockedForUser(req.user.id, lesson.id);
      const { key, quizPayload, state } = await loadQuizAttemptState(
        req.user.id,
        lesson,
      );
      if (state.completed) {
        throw new ApiError(400, "Quiz already completed");
      }

      if (
        !quizPayload.settings.allowSkip &&
        questionIndex !== Number(state.currentQuestionIndex || 0)
      ) {
        throw new ApiError(400, "You must answer questions in order");
      }

      const question = quizPayload.questions[questionIndex];
      if (!question) {
        throw new ApiError(404, "Question not found");
      }

      const questionKey = question.id || `q-${questionIndex + 1}`;
      const submittedAnswer = req.body.answer;
      const validation = validateAnswer(question, submittedAnswer);
      const hintUsed = Boolean(state.hintUsage?.[questionKey]);
      const maxPoints = Number(question.points || 10);
      const deduction = hintUsed
        ? Number(quizPayload.settings.hintPenalty || 0)
        : 0;
      const awardedPoints = validation.isCorrect
        ? Math.max(0, maxPoints - deduction)
        : 0;

      state.answers = state.answers || {};
      state.answers[questionKey] = submittedAnswer;
      state.questionResults = state.questionResults || {};
      state.questionResults[questionKey] = {
        questionIndex,
        submittedAnswer,
        isCorrect: validation.isCorrect,
        correctAnswer: validation.correctAnswer,
        explanation:
          question.explanation ||
          "Review this concept before your next attempt.",
        awardedPoints,
        maxPoints,
        hintUsed,
        answeredAt: new Date().toISOString(),
      };

      if (!quizPayload.settings.allowSkip) {
        state.currentQuestionIndex = Math.min(
          questionIndex + 1,
          Math.max(quizPayload.questions.length - 1, 0),
        );
      } else {
        state.currentQuestionIndex = Number(
          req.body.nextQuestionIndex ?? questionIndex + 1,
        );
      }
      state.lastActivityAt = new Date().toISOString();

      await finalizeQuizCompletion(req.user.id, lesson.id, state, quizPayload);
      await saveQuizAttemptState(key, state);

      return res.json({
        data: {
          questionIndex,
          validation: state.questionResults[questionKey],
          metrics: state.metrics,
          completed: state.completed,
          passed: state.passed,
          nextQuestionIndex: state.currentQuestionIndex,
        },
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  "/course-curriculums/:lessonId/quiz-attempt/retry",
  authenticate,
  authorize("LEARNER"),
  async (req, res, next) => {
    try {
      const { lesson } = await ensureLearnerOwnsQuizLesson(
        req.user.id,
        req.params.lessonId,
      );
      await assertLessonUnlockedForUser(req.user.id, lesson.id);
      const { key, quizPayload, state } = await loadQuizAttemptState(
        req.user.id,
        lesson,
      );

      if (state.passed && !quizPayload.settings.allowRetakeAfterPass) {
        throw new ApiError(400, "Retake is not allowed for this quiz");
      }

      const nextAttemptNumber = Number(state.attemptNumber || 1) + 1;
      const resetState = {
        ...buildDefaultQuizState(quizPayload),
        attemptNumber: nextAttemptNumber,
        attemptHistory: Array.isArray(state.attemptHistory)
          ? state.attemptHistory
          : [],
      };

      await saveQuizAttemptState(key, resetState);

      return res.json({
        data: {
          lessonId: lesson.id,
          settings: quizPayload.settings,
          totalQuestions: quizPayload.questions.length,
          state: resetState,
        },
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  "/course-resources/videos/direct-upload-url",
  authenticate,
  authorize("EDUCATOR"),
  async (req, res, next) => {
    try {
      const lesson = await ensureEducatorOwnsLesson(
        req.user.id,
        req.body.curriculum_id,
      );
      if (!isCloudflareStreamEnabled()) {
        throw new ApiError(400, "Cloudflare Stream is not configured");
      }

      const duration = Math.max(1, Math.floor(Number(req.body.duration || 0) || 3600));
      const { uploadUrl, uid } = await createCloudflareDirectUpload({
        maxDurationSeconds: duration,
        requireSignedUrls: true,
        title: req.body.file_name || lesson.title || "Course video",
      });

      return res.status(201).json({
        data: {
          upload_url: uploadUrl,
          uid,
        },
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  "/course-resources/videos/complete",
  authenticate,
  authorize("EDUCATOR"),
  async (req, res, next) => {
    try {
      const lesson = await ensureEducatorOwnsLesson(
        req.user.id,
        req.body.curriculum_id,
      );

      const uid = String(req.body.uid || "").trim();
      if (!uid) {
        throw new ApiError(400, "Cloudflare video uid is required");
      }

      const videoPath = buildCloudflarePlaybackUrl(uid);
      triggerCloudflareAutoCaption(uid);
      const sizeInBytes = Number(req.body.size_in_bytes || 0);
      const media = await prisma.media.create({
        data: {
          userId: req.user.id,
          courseId: lesson.courseId,
          lessonId: lesson.id,
          storagePath: videoPath,
          originalName: String(req.body.original_name || "Course video").slice(0, 255),
          mimeType: String(req.body.mime_type || "video/mp4").slice(0, 255),
          mediaType: "VIDEO",
          sizeInBytes: Number.isFinite(sizeInBytes) && sizeInBytes > 0 ? sizeInBytes : 0,
        },
      });

      const updatedLesson = await prisma.lesson.update({
        where: { id: lesson.id },
        data: {
          videoUrl: videoPath,
          durationInSeconds: Number(req.body.duration || 0),
        },
      });

      return res.status(201).json({
        data: {
          curriculum: mapLessonToLegacyCurriculum(updatedLesson),
          asset: { id: media.id, path: videoPath },
        },
        path: videoPath,
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  "/course-resources/videos",
  authenticate,
  authorize("EDUCATOR"),
  upload.single("file"),
  async (req, res, next) => {
    try {
      const lesson = await ensureEducatorOwnsLesson(
        req.user.id,
        req.body.curriculum_id,
      );
      if (!req.file) {
        throw new ApiError(400, "File is required");
      }

      let videoPath = mediaPath(req.file);
      if (isCloudflareStreamEnabled()) {
        const fileBuffer = await readUploadedFileBuffer(req.file);
        const cloudflareVideoId = await uploadVideoToCloudflareStream({
          filename: req.file.originalname,
          title: req.file.originalname || lesson.title || "Course video",
          fileBuffer,
          contentType: req.file.mimetype,
        });
        videoPath = buildCloudflarePlaybackUrl(cloudflareVideoId);
        triggerCloudflareAutoCaption(cloudflareVideoId);
        await cleanupTransientUploadedFile(req.file);
      }

      const media = await prisma.media.create({
        data: {
          userId: req.user.id,
          courseId: lesson.courseId,
          lessonId: lesson.id,
          storagePath: videoPath,
          originalName: req.file.originalname,
          mimeType: req.file.mimetype,
          mediaType: "VIDEO",
          sizeInBytes: req.file.size,
        },
      });

      const updatedLesson = await prisma.lesson.update({
        where: { id: lesson.id },
        data: {
          videoUrl: videoPath,
          durationInSeconds: Number(req.body.duration || 0),
        },
      });

      return res.status(201).json({
        data: {
          curriculum: mapLessonToLegacyCurriculum(updatedLesson),
          asset: { id: media.id, path: videoPath },
        },
        path: videoPath,
      });
    } catch (error) {
      return next(error);
    }
  },
);

async function streamTokenHandler(req, res, next) {
  try {
    const queryId = req.query.id;
    if (!queryId) {
      throw new ApiError(400, "Missing media id");
    }

    const mediaSource = await resolveMediaSourceByQueryId(queryId);
    if (!mediaSource) {
      throw new ApiError(404, "Media not found");
    }

    await assertUserCanAccessMedia(req.user, mediaSource);

    const token = signStreamPlaybackToken({
      userId: req.user.id,
      mediaId: queryId,
      roles: req.user.roles,
    });
    const cloudflareVideoId = extractCloudflareVideoIdFromPlaybackUrl(
      mediaSource.storagePath,
    );
    const embedUrl = cloudflareVideoId
      ? await buildCloudflareSignedEmbedUrl(cloudflareVideoId, {
          ttlSeconds: 60,
        })
      : "";

    return res.json({
      data: {
        token,
        expiresInSeconds: 21600,
        embed_url: embedUrl || null,
      },
    });
  } catch (error) {
    return next(error);
  }
}

async function streamHandler(req, res, next) {
  try {
    const fetchDest = String(req.get("sec-fetch-dest") || "").toLowerCase();
    if (fetchDest === "document") {
      throw new ApiError(403, "Direct page access is not allowed");
    }
    assertPlaybackStreamRequest(req);

    const queryId = req.query.id;
    const streamToken = String(req.query.st || "").trim();
    if (!queryId) {
      throw new ApiError(400, "Missing media id");
    }

    if (!streamToken) {
      const publicPreviewMedia =
        await resolvePublicPreviewMediaByQueryId(queryId);
      if (!publicPreviewMedia) {
        throw new ApiError(403, "Missing stream token");
      }
      await sendMediaStoragePath(publicPreviewMedia.storagePath, req, res);
      return;
    }

    const streamPayload = verifyStreamPlaybackToken(streamToken);
    if (String(streamPayload.mediaId) !== String(queryId)) {
      throw new ApiError(403, "Stream token does not match media");
    }

    const mediaSource = await resolveMediaSourceByQueryId(queryId);
    if (!mediaSource) {
      throw new ApiError(404, "Media not found");
    }
    await assertUserCanAccessMedia(
      { id: String(streamPayload.sub), roles: streamPayload.roles || [] },
      mediaSource,
    );

    await sendMediaStoragePath(mediaSource.storagePath, req, res);
    return;
  } catch (error) {
    return next(error);
  }
}

router.get("/stream-token", authenticate, streamTokenHandler);
router.get("/stream-token.php", authenticate, streamTokenHandler);
router.get("/stream", streamHandler);
router.get("/stream.php", streamHandler);

router.delete(
  "/course-resources/videos/:lessonId",
  authenticate,
  authorize("EDUCATOR"),
  async (req, res, next) => {
    try {
      const lesson = await ensureEducatorOwnsLesson(
        req.user.id,
        req.params.lessonId,
      );
      const existingCloudflareVideoId = isCloudflareStreamEnabled()
        ? extractCloudflareVideoIdFromPlaybackUrl(lesson.videoUrl)
        : "";
      const updatedLesson = await prisma.lesson.update({
        where: { id: lesson.id },
        data: { videoUrl: null },
      });
      if (existingCloudflareVideoId) {
        await deleteCloudflareStreamVideo(existingCloudflareVideoId).catch(
          () => {},
        );
      }
      return res.json({
        data: {
          curriculum: mapLessonToLegacyCurriculum(updatedLesson),
          asset: null,
        },
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  "/course-resources/articles",
  authenticate,
  authorize("EDUCATOR"),
  async (req, res, next) => {
    try {
      const lesson = await ensureEducatorOwnsLesson(
        req.user.id,
        req.body.curriculum_id,
      );
      const updatedLesson = await prisma.lesson.update({
        where: { id: lesson.id },
        data: {
          assignmentText: req.body.content,
        },
      });

      return res.status(201).json({
        data: {
          curriculum: mapLessonToLegacyCurriculum(updatedLesson),
          asset: { content: updatedLesson.assignmentText || "" },
        },
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.delete(
  "/course-resources/articles/:lessonId",
  authenticate,
  authorize("EDUCATOR"),
  async (req, res, next) => {
    try {
      const lesson = await ensureEducatorOwnsLesson(
        req.user.id,
        req.params.lessonId,
      );
      const updatedLesson = await prisma.lesson.update({
        where: { id: lesson.id },
        data: {
          assignmentText: null,
        },
      });
      return res.json({
        data: {
          curriculum: mapLessonToLegacyCurriculum(updatedLesson),
          asset: null,
        },
      });
    } catch (error) {
      return next(error);
    }
  },
);

router.post(
  "/payout-accounts/paypal",
  authenticate,
  authorize("EDUCATOR"),
  async (req, res, next) => {
    try {
      const account = await prisma.payoutAccount.upsert({
        where: { userId: req.user.id },
        update: {
          paypalEmail: req.body.email,
          paypalMerchantId: req.body.accountId || null,
          isVerified: true,
        },
        create: {
          userId: req.user.id,
          paypalEmail: req.body.email,
          paypalMerchantId: req.body.accountId || null,
          isVerified: true,
        },
      });

      return res.status(201).json({ data: account });
    } catch (error) {
      return next(error);
    }
  },
);

router.get(
  "/payout-accounts",
  authenticate,
  authorize("EDUCATOR"),
  async (req, res, next) => {
    try {
      const account = await prisma.payoutAccount.findUnique({
        where: { userId: req.user.id },
      });
      const data = account
        ? [
            {
              provider: "paypal",
              provider_email: account.paypalEmail,
              provider_account_id: account.paypalMerchantId,
              is_default: "1",
            },
          ]
        : [];
      return res.json(data);
    } catch (error) {
      return next(error);
    }
  },
);

router.get("/2fa-status", authenticate, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        twoFactorEnabled: true,
        twoFactorTempSecret: true,
        twoFactorBackupHashes: true,
      },
    });

    if (!user) {
      throw new ApiError(404, "User not found");
    }

    const backupCodesRemaining = countBackupCodes(user.twoFactorBackupHashes);

    return res.json({
      enabled: Boolean(user.twoFactorEnabled),
      totp_enabled: Boolean(user.twoFactorEnabled),
      setup_required: Boolean(
        !user.twoFactorEnabled && user.twoFactorTempSecret,
      ),
      backup_codes_remaining: backupCodesRemaining,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/setup-2fa", authenticate, async (req, res, next) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        email: true,
        twoFactorEnabled: true,
      },
    });

    if (!user) {
      throw new ApiError(404, "User not found");
    }
    if (user.twoFactorEnabled) {
      throw new ApiError(400, "Two-factor authentication is already enabled");
    }

    const setup = await createTwoFactorSetup(user.email);
    await prisma.user.update({
      where: { id: user.id },
      data: {
        twoFactorTempSecret: setup.base32Secret,
      },
    });

    return res.json({
      qr_code: setup.qrCode,
      secret: setup.base32Secret,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/confirm-2fa", authenticate, async (req, res, next) => {
  try {
    const code = String(req.body?.code || "").trim();
    if (!/^\d{6}$/.test(code)) {
      throw new ApiError(400, "A valid 6-digit code is required");
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        twoFactorEnabled: true,
        twoFactorTempSecret: true,
      },
    });

    if (!user) {
      throw new ApiError(404, "User not found");
    }
    if (user.twoFactorEnabled) {
      throw new ApiError(400, "Two-factor authentication is already enabled");
    }
    if (!user.twoFactorTempSecret) {
      throw new ApiError(400, "Two-factor setup has not been initialized");
    }

    const valid = verifyTotpToken(user.twoFactorTempSecret, code);
    if (!valid) {
      throw new ApiError(400, "Invalid authenticator code");
    }

    const { rawCodes, hashedCodes } = await generateBackupCodes();
    await prisma.user.update({
      where: { id: user.id },
      data: {
        twoFactorEnabled: true,
        twoFactorSecret: user.twoFactorTempSecret,
        twoFactorTempSecret: null,
        twoFactorBackupHashes: hashedCodes,
      },
    });

    return res.json({
      message: "Two-factor authentication enabled",
      backup_codes: rawCodes,
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/verify-2fa", async (req, res, next) => {
  try {
    const preAuthToken = String(req.body?.pre_auth_token || "").trim();
    const code = String(req.body?.code || "").trim();
    const deviceIdentifier = String(req.body?.deviceIdentifier || "").trim();
    const claimedDeviceName = String(req.body?.deviceName || "").trim();
    const clientLocationLabel = String(req.body?.locationLabel || "").trim();
    const rememberDevice = toBoolean(req.body?.rememberDevice, true);
    if (!preAuthToken) {
      throw new ApiError(400, "pre_auth_token is required");
    }
    if (!/^\d{6}$/.test(code)) {
      throw new ApiError(400, "A valid 6-digit code is required");
    }

    let payload;
    try {
      payload = verifyPreAuthToken(preAuthToken);
    } catch (_error) {
      throw new ApiError(401, "Invalid or expired pre-auth token");
    }

    const user = await findUserWithRolesById(payload.sub);
    if (!user || user.deletedAt || !user.isActive) {
      throw new ApiError(401, "Invalid login session");
    }
    if (!user.twoFactorEnabled || !user.twoFactorSecret) {
      throw new ApiError(400, "Two-factor authentication is not enabled");
    }

    const valid = verifyTotpToken(user.twoFactorSecret, code);
    if (!valid) {
      throw new ApiError(401, "Invalid authenticator code");
    }

    const accessToken = signAccessToken(buildTokenPayload(user));
    const refreshToken = signRefreshToken(buildTokenPayload(user));
    const refreshTokenHash = await hashToken(refreshToken);
    await prisma.user.update({
      where: { id: user.id },
      data: { refreshTokenHash },
    });

    const requestUserAgent = getRequestUserAgent(req);
    const requestIpAddress = getRequestIpAddress(req);
    const requestLocationLabel = resolveDeviceLocationLabel(
      req,
      clientLocationLabel,
    );
    const deviceName = claimedDeviceName || buildDeviceName(requestUserAgent);
    const knownDeviceBefore = await hasActiveTrustedDeviceByIdentifier(
      user.id,
      deviceIdentifier,
    );
    let trustedDeviceToken = null;
    let isNewDevice = !knownDeviceBefore;
    if (rememberDevice) {
      const saved = await registerTrustedDevice(user.id, {
        deviceIdentifier,
        deviceName,
        userAgent: requestUserAgent,
        ipAddress: requestIpAddress,
        locationLabel: requestLocationLabel,
      });
      trustedDeviceToken = saved.trustedDeviceToken;
      isNewDevice = Boolean(saved.isNewDevice);
    }

    if (isNewDevice) {
      await notifyNewDeviceLogin(user.id, {
        deviceName,
        locationLabel: requestLocationLabel,
        ipAddress: requestIpAddress,
        provider: "2fa_totp",
      });
    }

    await recordActivityEvent({
      eventType: "AUTH_LOGIN",
      userId: user.id,
      metadata: {
        method: "2fa_totp",
        rememberedDevice: rememberDevice,
        device: deviceName,
        location: requestLocationLabel,
        ipAddress: requestIpAddress,
      },
      dedupeWindowSeconds: 5,
    });

    return res.json({
      status: "success",
      token: accessToken,
      accessToken,
      refreshToken,
      trustedDeviceToken,
      user: mapAuthUser(user),
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/disable-2fa", authenticate, async (req, res, next) => {
  try {
    const code = String(req.body?.code || "").trim();
    if (!/^\d{6}$/.test(code)) {
      throw new ApiError(400, "A valid 6-digit code is required");
    }

    const user = await prisma.user.findUnique({
      where: { id: req.user.id },
      select: {
        id: true,
        twoFactorEnabled: true,
        twoFactorSecret: true,
      },
    });

    if (!user) {
      throw new ApiError(404, "User not found");
    }
    if (!user.twoFactorEnabled || !user.twoFactorSecret) {
      throw new ApiError(400, "Two-factor authentication is not enabled");
    }

    const valid = verifyTotpToken(user.twoFactorSecret, code);
    if (!valid) {
      throw new ApiError(401, "Invalid authenticator code");
    }

    await prisma.user.update({
      where: { id: user.id },
      data: {
        twoFactorEnabled: false,
        twoFactorSecret: null,
        twoFactorTempSecret: null,
        twoFactorBackupHashes: null,
      },
    });

    return res.json({
      message: "Two-factor authentication disabled",
    });
  } catch (error) {
    return next(error);
  }
});

router.post("/verify-backup-code", async (req, res, next) => {
  try {
    const preAuthToken = String(req.body?.pre_auth_token || "").trim();
    const code = String(req.body?.code || "").trim();
    const deviceIdentifier = String(req.body?.deviceIdentifier || "").trim();
    const claimedDeviceName = String(req.body?.deviceName || "").trim();
    const clientLocationLabel = String(req.body?.locationLabel || "").trim();
    const rememberDevice = toBoolean(req.body?.rememberDevice, true);
    if (!preAuthToken) {
      throw new ApiError(400, "pre_auth_token is required");
    }
    if (!code) {
      throw new ApiError(400, "Backup code is required");
    }

    let payload;
    try {
      payload = verifyPreAuthToken(preAuthToken);
    } catch (_error) {
      throw new ApiError(401, "Invalid or expired pre-auth token");
    }

    const user = await findUserWithRolesById(payload.sub);
    if (!user || user.deletedAt || !user.isActive) {
      throw new ApiError(401, "Invalid login session");
    }
    if (!user.twoFactorEnabled || !user.twoFactorSecret) {
      throw new ApiError(400, "Two-factor authentication is not enabled");
    }

    const consumedResult = await consumeBackupCode(
      code,
      user.twoFactorBackupHashes,
    );
    if (!consumedResult.consumed) {
      throw new ApiError(401, "Invalid or already used backup code");
    }

    const accessToken = signAccessToken(buildTokenPayload(user));
    const refreshToken = signRefreshToken(buildTokenPayload(user));
    const refreshTokenHash = await hashToken(refreshToken);
    await prisma.user.update({
      where: { id: user.id },
      data: {
        refreshTokenHash,
        twoFactorBackupHashes: consumedResult.nextHashes,
      },
    });

    const requestUserAgent = getRequestUserAgent(req);
    const requestIpAddress = getRequestIpAddress(req);
    const requestLocationLabel = resolveDeviceLocationLabel(
      req,
      clientLocationLabel,
    );
    const deviceName = claimedDeviceName || buildDeviceName(requestUserAgent);
    const knownDeviceBefore = await hasActiveTrustedDeviceByIdentifier(
      user.id,
      deviceIdentifier,
    );
    let trustedDeviceToken = null;
    let isNewDevice = !knownDeviceBefore;
    if (rememberDevice) {
      const saved = await registerTrustedDevice(user.id, {
        deviceIdentifier,
        deviceName,
        userAgent: requestUserAgent,
        ipAddress: requestIpAddress,
        locationLabel: requestLocationLabel,
      });
      trustedDeviceToken = saved.trustedDeviceToken;
      isNewDevice = Boolean(saved.isNewDevice);
    }

    if (isNewDevice) {
      await notifyNewDeviceLogin(user.id, {
        deviceName,
        locationLabel: requestLocationLabel,
        ipAddress: requestIpAddress,
        provider: "2fa_backup_code",
      });
    }

    await recordActivityEvent({
      eventType: "AUTH_LOGIN",
      userId: user.id,
      metadata: {
        method: "2fa_backup_code",
        rememberedDevice: rememberDevice,
        device: deviceName,
        location: requestLocationLabel,
        ipAddress: requestIpAddress,
      },
      dedupeWindowSeconds: 5,
    });

    return res.json({
      status: "success",
      token: accessToken,
      accessToken,
      refreshToken,
      trustedDeviceToken,
      user: mapAuthUser(user),
      backup_codes_remaining: consumedResult.nextHashes.length,
    });
  } catch (error) {
    return next(error);
  }
});

router.post(
  "/regenerate-backup-codes",
  authenticate,
  async (req, res, next) => {
    try {
      const code = String(req.body?.code || "").trim();
      if (!/^\d{6}$/.test(code)) {
        throw new ApiError(400, "A valid 6-digit code is required");
      }

      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: {
          id: true,
          twoFactorEnabled: true,
          twoFactorSecret: true,
        },
      });

      if (!user) {
        throw new ApiError(404, "User not found");
      }
      if (!user.twoFactorEnabled || !user.twoFactorSecret) {
        throw new ApiError(400, "Two-factor authentication is not enabled");
      }

      const valid = verifyTotpToken(user.twoFactorSecret, code);
      if (!valid) {
        throw new ApiError(401, "Invalid authenticator code");
      }

      const { rawCodes, hashedCodes } = await generateBackupCodes();
      await prisma.user.update({
        where: { id: user.id },
        data: {
          twoFactorBackupHashes: hashedCodes,
        },
      });

      return res.json({
        message: "Backup codes regenerated",
        backup_codes: rawCodes,
      });
    } catch (error) {
      return next(error);
    }
  },
);

export default router;
