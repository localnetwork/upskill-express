import crypto from "crypto";
import { prisma } from "../../shared/database/prisma.js";
import { env } from "../../shared/config/env.js";
import { ApiError } from "../../shared/utils/ApiError.js";

const CERTIFICATE_KEY_PREFIX = "certificate::";
const CERTIFICATE_INDEX_KEY_PREFIX = "certificate_index::";

function getCertificateSettingKey(slug) {
  return `${CERTIFICATE_KEY_PREFIX}${slug}`;
}

function getCertificateIndexKey(userId, courseId) {
  return `${CERTIFICATE_INDEX_KEY_PREFIX}${userId}::${courseId}`;
}

function safeParseJson(value) {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch (_error) {
    return null;
  }
}

function generateCertificateSlug() {
  return crypto.randomBytes(12).toString("hex");
}

function generateCertificationNo() {
  const year = new Date().getFullYear();
  const suffix = crypto.randomBytes(3).toString("hex").toUpperCase();
  return `UPSK-${year}-${suffix}`;
}

function generateReferenceNo() {
  return `REF-${new Date().getFullYear()}-${crypto
    .randomBytes(4)
    .toString("hex")
    .toUpperCase()}`;
}

function getDisplayName(user) {
  const fullName = `${user?.firstName || ""} ${user?.lastName || ""}`.trim();
  return fullName || user?.username || "Unknown";
}

function normalizeStoredCertificate(value) {
  const parsed = safeParseJson(value);
  if (!parsed) {
    throw new ApiError(500, "Stored certificate data is invalid");
  }

  return {
    slug: parsed.slug,
    certification_no: parsed.certificationNo,
    certification_url: parsed.certificationUrl,
    reference_no: parsed.referenceNo,
    course_title: parsed.courseTitle,
    instructor_name: parsed.instructorName,
    student_name: parsed.studentName,
    issued_at: parsed.issuedAt,
  };
}

export async function getCertificateBySlug(slug) {
  const normalizedSlug = String(slug || "").trim();
  if (!normalizedSlug) {
    throw new ApiError(400, "Certificate slug is required");
  }

  const setting = await prisma.platformSetting.findUnique({
    where: { key: getCertificateSettingKey(normalizedSlug) },
    select: { value: true },
  });

  if (!setting?.value) {
    throw new ApiError(404, "Certificate not found");
  }

  return normalizeStoredCertificate(setting.value);
}

export async function generateCourseCertificate(userId, courseSlug) {
  const enrollment = await prisma.enrollment.findFirst({
    where: {
      userId,
      status: { in: ["ACTIVE", "COMPLETED"] },
      course: {
        slug: String(courseSlug || "").trim(),
        deletedAt: null,
      },
    },
    include: {
      user: {
        select: { id: true, firstName: true, lastName: true, username: true },
      },
      course: {
        select: {
          id: true,
          slug: true,
          title: true,
          educator: {
            select: { firstName: true, lastName: true, username: true },
          },
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
  });

  if (!enrollment) {
    throw new ApiError(404, "Enrollment not found");
  }

  const progressPct = Number(enrollment.courseProgress?.progressPct || 0);
  const completedLessons = Number(enrollment.courseProgress?.completedLessons || 0);
  const totalLessons = Number(enrollment.courseProgress?.totalLessons || 0);
  const isCompleted =
    progressPct >= 100 ||
    enrollment.status === "COMPLETED" ||
    Boolean(enrollment.courseProgress?.completedAt) ||
    (totalLessons > 0 && completedLessons >= totalLessons);

  if (!isCompleted) {
    throw new ApiError(400, "Course must be fully completed before generating certificate");
  }

  const indexKey = getCertificateIndexKey(userId, enrollment.course.id);
  const existingIndex = await prisma.platformSetting.findUnique({
    where: { key: indexKey },
    select: { value: true },
  });

  const existingIndexPayload = safeParseJson(existingIndex?.value);
  if (existingIndexPayload?.slug) {
    return getCertificateBySlug(existingIndexPayload.slug);
  }

  const slug = generateCertificateSlug();
  const certificationNo = generateCertificationNo();
  const referenceNo = generateReferenceNo();
  const issuedAt = new Date().toISOString();
  const certificationUrl = `${env.frontendUrl.replace(/\/+$/, "")}/certifications/${slug}`;
  const payload = {
    slug,
    certificationNo,
    certificationUrl,
    referenceNo,
    courseTitle: enrollment.course.title,
    instructorName: getDisplayName(enrollment.course.educator),
    studentName: getDisplayName(enrollment.user),
    issuedAt,
    userId,
    courseId: enrollment.course.id,
  };

  await prisma.platformSetting.create({
    data: {
      key: getCertificateSettingKey(slug),
      value: JSON.stringify(payload),
      description: `Certificate for user ${userId} course ${enrollment.course.id}`,
    },
  });

  await prisma.platformSetting.upsert({
    where: { key: indexKey },
    create: {
      key: indexKey,
      value: JSON.stringify({ slug, certificationNo, referenceNo, issuedAt }),
      description: `Certificate index for user ${userId} and course ${enrollment.course.id}`,
    },
    update: {
      value: JSON.stringify({ slug, certificationNo, referenceNo, issuedAt }),
      description: `Certificate index for user ${userId} and course ${enrollment.course.id}`,
    },
  });

  return normalizeStoredCertificate(JSON.stringify(payload));
}
