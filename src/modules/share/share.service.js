import crypto from "crypto";
import { prisma } from "../../shared/database/prisma.js";
import { env } from "../../shared/config/env.js";
import { ApiError } from "../../shared/utils/ApiError.js";

const COURSE_SHARE_INDEX_PREFIX = "course_share_index::";
const COURSE_SHARE_CODE_PREFIX = "course_share_code::";
const SHARE_CODE_LENGTH = 8;
const MAX_CODE_GENERATION_ATTEMPTS = 20;

function getCourseShareIndexKey(courseId) {
  return `${COURSE_SHARE_INDEX_PREFIX}${courseId}`;
}

function getCourseShareCodeKey(code) {
  return `${COURSE_SHARE_CODE_PREFIX}${code}`;
}

function normalizeCourseSlug(value) {
  return String(value || "").trim();
}

function normalizeShareCode(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .toLowerCase()
    .slice(0, 32);
}

function safeParseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
}

function baseFrontendUrl() {
  return String(env.frontendUrl || "http://localhost:3000").replace(/\/+$/, "");
}

function generateShareCode() {
  return crypto
    .randomBytes(12)
    .toString("base64url")
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .toLowerCase()
    .slice(0, SHARE_CODE_LENGTH);
}

function toSharePayload({ code, courseSlug }) {
  const shortPath = `/share/${code}`;
  const shortUrl = `${baseFrontendUrl()}${shortPath}`;
  const targetPath = `/courses/${courseSlug}`;
  const targetUrl = `${baseFrontendUrl()}${targetPath}`;

  return {
    code,
    short_path: shortPath,
    short_url: shortUrl,
    target_path: targetPath,
    target_url: targetUrl,
  };
}

async function findPublishedCourseBySlug(slug) {
  return prisma.course.findFirst({
    where: {
      slug,
      deletedAt: null,
      workflowStatus: "PUBLISHED",
    },
    select: {
      id: true,
      slug: true,
      title: true,
    },
  });
}

async function getExistingCourseSharePayload(course) {
  const indexSetting = await prisma.platformSetting.findUnique({
    where: { key: getCourseShareIndexKey(course.id) },
    select: { value: true },
  });

  const indexPayload = safeParseJson(indexSetting?.value);
  const existingCode = normalizeShareCode(indexPayload?.code);
  if (!existingCode) return null;

  const codeSetting = await prisma.platformSetting.findUnique({
    where: { key: getCourseShareCodeKey(existingCode) },
    select: { value: true },
  });
  const codePayload = safeParseJson(codeSetting?.value);
  const codeCourseId = String(codePayload?.courseId || "");

  if (codeCourseId !== course.id) return null;
  return toSharePayload({ code: existingCode, courseSlug: course.slug });
}

export async function createOrGetCourseShareLink(courseSlugInput) {
  const courseSlug = normalizeCourseSlug(courseSlugInput);
  if (!courseSlug) {
    throw new ApiError(400, "Course slug is required");
  }

  const course = await findPublishedCourseBySlug(courseSlug);
  if (!course) {
    throw new ApiError(404, "Course not found");
  }

  const existing = await getExistingCourseSharePayload(course);
  if (existing) return existing;

  let code = "";
  for (let attempt = 0; attempt < MAX_CODE_GENERATION_ATTEMPTS; attempt += 1) {
    const candidateCode = generateShareCode();
    if (!candidateCode) continue;

    try {
      await prisma.platformSetting.create({
        data: {
          key: getCourseShareCodeKey(candidateCode),
          value: JSON.stringify({
            courseId: course.id,
            createdAt: new Date().toISOString(),
          }),
          description: `Course share code for course ${course.id}`,
        },
      });
      code = candidateCode;
      break;
    } catch (error) {
      if (error?.code === "P2002") {
        continue;
      }
      throw error;
    }
  }

  if (!code) {
    throw new ApiError(500, "Unable to generate share link");
  }

  try {
    await prisma.platformSetting.create({
      data: {
        key: getCourseShareIndexKey(course.id),
        value: JSON.stringify({
          code,
          updatedAt: new Date().toISOString(),
        }),
        description: `Course share index for course ${course.id}`,
      },
    });
  } catch (error) {
    if (error?.code === "P2002") {
      await prisma.platformSetting.deleteMany({
        where: {
          key: getCourseShareCodeKey(code),
        },
      });
      const existingAfterConflict = await getExistingCourseSharePayload(course);
      if (existingAfterConflict) return existingAfterConflict;
      throw new ApiError(409, "Course share link already exists");
    }
    throw error;
  }

  return toSharePayload({ code, courseSlug: course.slug });
}

export async function resolveCourseShareLink(codeInput) {
  const code = normalizeShareCode(codeInput);
  if (!code) {
    throw new ApiError(400, "Share code is required");
  }

  const codeSetting = await prisma.platformSetting.findUnique({
    where: { key: getCourseShareCodeKey(code) },
    select: { value: true },
  });
  if (!codeSetting?.value) {
    throw new ApiError(404, "Share link not found");
  }

  const codePayload = safeParseJson(codeSetting.value);
  const courseId = String(codePayload?.courseId || "");
  if (!courseId) {
    throw new ApiError(404, "Share link not found");
  }

  const course = await prisma.course.findFirst({
    where: {
      id: courseId,
      deletedAt: null,
      workflowStatus: "PUBLISHED",
    },
    select: { slug: true },
  });
  if (!course?.slug) {
    throw new ApiError(404, "Course not found");
  }

  return toSharePayload({ code, courseSlug: course.slug });
}
