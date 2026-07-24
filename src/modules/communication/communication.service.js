import { prisma } from "../../shared/database/prisma.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { getPagination, toPagedResult } from "../../shared/utils/pagination.js";
import { createNotification } from "../notification/notification.service.js";
import { recordActivityEvent } from "../analytics/analytics.service.js";

const ANNOUNCEMENT_DRAFT_KEY_PREFIX = "communication:announcement-draft:";
const ANNOUNCEMENT_HISTORY_KEY_PREFIX = "communication:announcement-history:";
const IMPORTANT_KEYWORDS = ["urgent", "issue", "problem", "stuck", "help", "error"];

function toSafeNumber(value, fallback = 0) {
  const next = Number(value);
  return Number.isFinite(next) ? next : fallback;
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function getAnnouncementDraftKey(userId) {
  return `${ANNOUNCEMENT_DRAFT_KEY_PREFIX}${userId}`;
}

function getAnnouncementHistoryKey(userId) {
  return `${ANNOUNCEMENT_HISTORY_KEY_PREFIX}${userId}`;
}

async function assertOwnedCourseIfSpecified(educatorId, courseId) {
  if (!courseId || courseId === "all") return;
  const course = await prisma.course.findFirst({
    where: {
      id: String(courseId),
      educatorId,
      deletedAt: null,
    },
    select: { id: true },
  });
  if (!course) {
    throw new ApiError(404, "Course not found for this instructor");
  }
}

function classifyProgressBucket(progressPct) {
  const value = Math.max(0, toSafeNumber(progressPct, 0));
  if (value <= 0) return "zero";
  if (value < 50) return "oneToFortyNine";
  if (value < 100) return "fiftyToNinetyNine";
  return "completed";
}

export async function listInstructorCommunicationCourses(educatorId) {
  return prisma.course.findMany({
    where: {
      educatorId,
      deletedAt: null,
    },
    select: {
      id: true,
      slug: true,
      title: true,
    },
    orderBy: { title: "asc" },
  });
}

export async function listInstructorQa(educatorId, query = {}) {
  const { page, limit, skip } = getPagination(query);
  const onlyUnanswered = toBoolean(query.onlyUnanswered, false);
  const courseId = String(query.courseId || "").trim();

  const where = {
    course: {
      educatorId,
      deletedAt: null,
      ...(courseId && courseId !== "all" ? { id: courseId } : {}),
    },
    OR: [
      { title: { contains: "?", mode: "insensitive" } },
      { comment: { contains: "?", mode: "insensitive" } },
    ],
    ...(onlyUnanswered ? { authorReplyAt: null } : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.review.findMany({
      where,
      skip,
      take: limit,
      include: {
        user: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
          },
        },
        course: {
          select: {
            id: true,
            title: true,
            slug: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.review.count({ where }),
  ]);

  const data = rows.map((row) => ({
    id: row.id,
    question: row.title || row.comment || "Learner question",
    details: row.comment || row.title || "",
    createdAt: row.createdAt,
    answered: Boolean(row.authorReplyAt),
    answeredAt: row.authorReplyAt,
    learner: {
      id: row.user?.id || null,
      username: row.user?.username || "",
      fullName:
        `${row.user?.firstName || ""} ${row.user?.lastName || ""}`.trim() ||
        row.user?.username ||
        "Learner",
    },
    course: row.course,
  }));

  return toPagedResult(data, total, page, limit);
}

export async function getInstructorAiInsights(educatorId) {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const [enrollments, lowRatingReviews, questionReviews] = await Promise.all([
    prisma.enrollment.findMany({
      where: {
        status: { in: ["ACTIVE", "COMPLETED"] },
        course: {
          educatorId,
          deletedAt: null,
        },
      },
      select: {
        id: true,
        enrolledAt: true,
        courseProgress: {
          select: {
            progressPct: true,
          },
        },
      },
    }),
    prisma.review.count({
      where: {
        course: {
          educatorId,
          deletedAt: null,
        },
        rating: {
          lte: 2,
        },
        createdAt: {
          gte: thirtyDaysAgo,
        },
      },
    }),
    prisma.review.count({
      where: {
        course: {
          educatorId,
          deletedAt: null,
        },
        OR: [
          { title: { contains: "?", mode: "insensitive" } },
          { comment: { contains: "?", mode: "insensitive" } },
        ],
        authorReplyAt: null,
      },
    }),
  ]);

  const totalLearners = enrollments.length;
  const atRiskLearners = enrollments.filter((enrollment) => {
    const progressPct = toSafeNumber(enrollment?.courseProgress?.progressPct, 0);
    return progressPct < 50;
  }).length;

  let topConcern = "Learner progress is healthy.";
  let suggestedAction = "Keep posting regular short updates.";

  if (atRiskLearners > 0 && atRiskLearners >= lowRatingReviews) {
    topConcern = `${atRiskLearners} learners are below 50% progress.`;
    suggestedAction = "Send a motivational announcement targeting low-progress learners.";
  } else if (lowRatingReviews > 0) {
    topConcern = `${lowRatingReviews} low-rating reviews were posted in the last 30 days.`;
    suggestedAction = "Address recurring concerns in a course-wide clarification post.";
  } else if (questionReviews > 0) {
    topConcern = `${questionReviews} learner questions are still unanswered.`;
    suggestedAction = "Prioritize unanswered Q&A to reduce learner drop-off.";
  }

  return {
    totalLearners,
    atRiskLearners,
    lowRatingReviewsLast30Days: lowRatingReviews,
    unansweredQuestions: questionReviews,
    topConcern,
    suggestedAction,
  };
}

export async function listInstructorMessages(educatorId, query = {}) {
  const { page, limit, skip } = getPagination(query);
  const unread = toBoolean(query.unread, false);
  const important = toBoolean(query.important, false);
  const notAnswered = toBoolean(query.notAnswered, false);
  const showAutomated = toBoolean(query.showAutomated, true);
  const sort = String(query.sort || "recent").toLowerCase() === "oldest" ? "oldest" : "recent";

  const [reviews, notifications] = await Promise.all([
    prisma.review.findMany({
      where: {
        course: {
          educatorId,
          deletedAt: null,
        },
      },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
          },
        },
        course: {
          select: {
            id: true,
            slug: true,
            title: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 250,
    }),
    prisma.notification.findMany({
      where: {
        userId: educatorId,
        OR: [
          { type: "SYSTEM" },
          {
            metadata: {
              path: ["notificationKind"],
              equals: "AUTOMATED_MESSAGE",
            },
          },
        ],
      },
      orderBy: { createdAt: "desc" },
      take: 150,
    }),
  ]);

  const reviewMessages = reviews.map((row) => {
    const title = String(row.title || "").trim();
    const comment = String(row.comment || "").trim();
    const combinedText = `${title} ${comment}`.toLowerCase();
    const isImportant =
      row.rating <= 2 || IMPORTANT_KEYWORDS.some((keyword) => combinedText.includes(keyword));

    return {
      id: `review:${row.id}`,
      sourceType: "STUDENT_REVIEW",
      sender: {
        id: row.user?.id || null,
        name:
          `${row.user?.firstName || ""} ${row.user?.lastName || ""}`.trim() ||
          row.user?.username ||
          "Learner",
      },
      course: row.course,
      subject: title || "Learner course feedback",
      preview: comment || title || "No message preview",
      unread: !row.authorReplyAt,
      important: isImportant,
      answered: Boolean(row.authorReplyAt),
      automated: false,
      createdAt: row.createdAt,
      relatedReviewId: row.id,
    };
  });

  const automatedMessages = notifications.map((row) => ({
    id: `notification:${row.id}`,
    sourceType: "SYSTEM_NOTIFICATION",
    sender: {
      id: null,
      name: "System",
    },
    course: null,
    subject: row.title,
    preview: row.message,
    unread: !row.readAt,
    important: false,
    answered: true,
    automated: true,
    createdAt: row.createdAt,
    relatedNotificationId: row.id,
  }));

  let merged = [...reviewMessages, ...automatedMessages];

  if (unread) merged = merged.filter((item) => item.unread);
  if (important) merged = merged.filter((item) => item.important);
  if (notAnswered) merged = merged.filter((item) => !item.answered);
  if (!showAutomated) merged = merged.filter((item) => !item.automated);

  merged.sort((a, b) => {
    const aTime = new Date(a.createdAt).getTime();
    const bTime = new Date(b.createdAt).getTime();
    return sort === "oldest" ? aTime - bTime : bTime - aTime;
  });

  const total = merged.length;
  const paged = merged.slice(skip, skip + limit);

  return {
    ...toPagedResult(paged, total, page, limit),
    summary: {
      totalMessages: total,
      unreadMessages: merged.filter((item) => item.unread).length,
      unansweredMessages: merged.filter((item) => !item.answered).length,
    },
  };
}

export async function listInstructorAssignments(educatorId) {
  const [assignmentLessons, enrollmentCounts] = await Promise.all([
    prisma.lesson.findMany({
      where: {
        type: "ASSIGNMENT",
        course: {
          educatorId,
          deletedAt: null,
        },
      },
      select: {
        id: true,
        title: true,
        createdAt: true,
        courseId: true,
        course: {
          select: {
            id: true,
            title: true,
            slug: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
    prisma.enrollment.groupBy({
      by: ["courseId"],
      where: {
        status: {
          in: ["ACTIVE", "COMPLETED"],
        },
        course: {
          educatorId,
          deletedAt: null,
        },
      },
      _count: {
        _all: true,
      },
    }),
  ]);

  const enrolledByCourseId = Object.fromEntries(
    enrollmentCounts.map((row) => [row.courseId, Number(row?._count?._all || 0)]),
  );

  const rows = await Promise.all(
    assignmentLessons.map(async (lesson) => {
      const completedCount = await prisma.lessonProgress.count({
        where: {
          lessonId: lesson.id,
          isCompleted: true,
        },
      });
      const enrolledCount = Number(enrolledByCourseId[lesson.courseId] || 0);
      const pendingCount = Math.max(enrolledCount - completedCount, 0);
      return {
        id: lesson.id,
        title: lesson.title || "Assignment",
        course: lesson.course,
        enrolledCount,
        completedCount,
        pendingCount,
        createdAt: lesson.createdAt,
      };
    }),
  );

  return rows;
}

export async function getAnnouncementDraft(educatorId) {
  const setting = await prisma.platformSetting.findUnique({
    where: {
      key: getAnnouncementDraftKey(educatorId),
    },
    select: {
      value: true,
      updatedAt: true,
    },
  });

  if (!setting?.value) {
    return { draft: null, updatedAt: null };
  }

  try {
    return {
      draft: JSON.parse(setting.value),
      updatedAt: setting.updatedAt,
    };
  } catch (_error) {
    throw new ApiError(500, "Stored announcement draft is invalid");
  }
}

export async function listAnnouncements(educatorId, query = {}) {
  const { page, limit } = getPagination(query);
  const setting = await prisma.platformSetting.findUnique({
    where: {
      key: getAnnouncementHistoryKey(educatorId),
    },
    select: {
      value: true,
    },
  });

  if (!setting?.value) {
    return toPagedResult([], 0, page, limit);
  }

  let rows = [];
  try {
    const parsed = JSON.parse(setting.value);
    rows = Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    throw new ApiError(500, "Stored announcement history is invalid");
  }

  rows.sort((a, b) => {
    const aTime = new Date(a?.sentAt || 0).getTime();
    const bTime = new Date(b?.sentAt || 0).getTime();
    return bTime - aTime;
  });

  const total = rows.length;
  const start = Math.max((page - 1) * limit, 0);
  const data = rows.slice(start, start + limit);
  return toPagedResult(data, total, page, limit);
}

async function appendAnnouncementHistory(educatorId, record) {
  const key = getAnnouncementHistoryKey(educatorId);
  const existing = await prisma.platformSetting.findUnique({
    where: { key },
    select: { value: true },
  });

  let history = [];
  if (existing?.value) {
    try {
      const parsed = JSON.parse(existing.value);
      history = Array.isArray(parsed) ? parsed : [];
    } catch (_error) {
      history = [];
    }
  }

  const nextHistory = [record, ...history].slice(0, 100);
  await prisma.platformSetting.upsert({
    where: { key },
    update: {
      value: JSON.stringify(nextHistory),
      description: "Instructor communication announcement history",
    },
    create: {
      key,
      value: JSON.stringify(nextHistory),
      description: "Instructor communication announcement history",
    },
  });
}

export async function saveAnnouncementDraft(educatorId, payload) {
  await assertOwnedCourseIfSpecified(educatorId, payload.courseId);
  if (payload.excludeCourseId) {
    await assertOwnedCourseIfSpecified(educatorId, payload.excludeCourseId);
  }

  const draft = {
    ...payload,
    subject: String(payload.subject || ""),
    body: String(payload.body || ""),
  };

  const updated = await prisma.platformSetting.upsert({
    where: {
      key: getAnnouncementDraftKey(educatorId),
    },
    update: {
      value: JSON.stringify(draft),
      description: "Instructor communication announcement draft",
    },
    create: {
      key: getAnnouncementDraftKey(educatorId),
      value: JSON.stringify(draft),
      description: "Instructor communication announcement draft",
    },
    select: {
      updatedAt: true,
    },
  });

  return {
    draft,
    updatedAt: updated.updatedAt,
  };
}

function applyEnrollmentDateFilters(enrollments, includeAfter, includeBefore) {
  const after = includeAfter ? new Date(includeAfter) : null;
  const before = includeBefore ? new Date(includeBefore) : null;
  return enrollments.filter((enrollment) => {
    const enrolledAt = new Date(enrollment.enrolledAt);
    if (after && enrolledAt < after) return false;
    if (before && enrolledAt > before) return false;
    return true;
  });
}

function applyProgressFilters(enrollments, payload) {
  const bucketsEnabled = {
    zero: toBoolean(payload.progressZero, true),
    oneToFortyNine: toBoolean(payload.progressOneToFortyNine, true),
    fiftyToNinetyNine: toBoolean(payload.progressFiftyToNinetyNine, true),
    completed: toBoolean(payload.progressCompleted, true),
  };

  return enrollments.filter((enrollment) => {
    const progressPct = toSafeNumber(enrollment?.courseProgress?.progressPct, 0);
    const bucket = classifyProgressBucket(progressPct);
    return Boolean(bucketsEnabled[bucket]);
  });
}

export async function sendAnnouncement(educatorId, payload) {
  await assertOwnedCourseIfSpecified(educatorId, payload.courseId);
  if (payload.excludeCourseId) {
    await assertOwnedCourseIfSpecified(educatorId, payload.excludeCourseId);
  }

  const baseCourseFilter =
    payload.courseId && payload.courseId !== "all" ? { id: payload.courseId } : {};

  let enrollments = await prisma.enrollment.findMany({
    where: {
      status: {
        in: ["ACTIVE", "COMPLETED"],
      },
      course: {
        educatorId,
        deletedAt: null,
        ...baseCourseFilter,
      },
    },
    select: {
      userId: true,
      enrolledAt: true,
      courseId: true,
      courseProgress: {
        select: {
          progressPct: true,
        },
      },
    },
  });

  if (toBoolean(payload.useEnrollmentDate, false)) {
    enrollments = applyEnrollmentDateFilters(
      enrollments,
      payload.includeAfter,
      payload.includeBefore,
    );
  }

  if (toBoolean(payload.useCourseProgress, false)) {
    enrollments = applyProgressFilters(enrollments, payload);
  }

  if (payload.excludeCourseId) {
    const excludedEnrollments = await prisma.enrollment.findMany({
      where: {
        status: {
          in: ["ACTIVE", "COMPLETED"],
        },
        courseId: payload.excludeCourseId,
      },
      select: {
        userId: true,
      },
    });
    const excludedUserIds = new Set(excludedEnrollments.map((row) => row.userId));
    enrollments = enrollments.filter((row) => !excludedUserIds.has(row.userId));
  }

  const uniqueUserIds = Array.from(new Set(enrollments.map((row) => row.userId)));

  await Promise.all(
    uniqueUserIds.map((userId) =>
      createNotification({
        userId,
        type: "SYSTEM",
        title: String(payload.subject).trim(),
        message: String(payload.body).trim(),
        metadata: {
          notificationKind: "INSTRUCTOR_ANNOUNCEMENT",
          educatorId,
          courseId: payload.courseId,
          filters: {
            useEnrollmentDate: toBoolean(payload.useEnrollmentDate, false),
            useCourseProgress: toBoolean(payload.useCourseProgress, false),
            includeAfter: payload.includeAfter || null,
            includeBefore: payload.includeBefore || null,
            progressZero: toBoolean(payload.progressZero, true),
            progressOneToFortyNine: toBoolean(payload.progressOneToFortyNine, true),
            progressFiftyToNinetyNine: toBoolean(payload.progressFiftyToNinetyNine, true),
            progressCompleted: toBoolean(payload.progressCompleted, true),
            excludeCourseId: payload.excludeCourseId || null,
          },
        },
      }),
    ),
  );
  const sentAt = new Date();
  await appendAnnouncementHistory(educatorId, {
    id: `${sentAt.getTime()}-${Math.random().toString(36).slice(2, 10)}`,
    courseId: payload.courseId,
    subject: String(payload.subject).trim(),
    body: String(payload.body).trim(),
    recipientsCount: uniqueUserIds.length,
    filters: {
      useEnrollmentDate: toBoolean(payload.useEnrollmentDate, false),
      useCourseProgress: toBoolean(payload.useCourseProgress, false),
      includeAfter: payload.includeAfter || null,
      includeBefore: payload.includeBefore || null,
      progressZero: toBoolean(payload.progressZero, true),
      progressOneToFortyNine: toBoolean(payload.progressOneToFortyNine, true),
      progressFiftyToNinetyNine: toBoolean(payload.progressFiftyToNinetyNine, true),
      progressCompleted: toBoolean(payload.progressCompleted, true),
      excludeCourseId: payload.excludeCourseId || null,
    },
    sentAt: sentAt.toISOString(),
  });

  await recordActivityEvent({
    eventType: "INSTRUCTOR_ANNOUNCEMENT_POSTED",
    userId: educatorId,
    courseId:
      payload.courseId && payload.courseId !== "all" ? String(payload.courseId) : undefined,
    pagePath: "/instructor/communication",
    metadata: {
      subject: String(payload.subject || "").trim(),
      recipientsCount: uniqueUserIds.length,
      filters: {
        useEnrollmentDate: toBoolean(payload.useEnrollmentDate, false),
        useCourseProgress: toBoolean(payload.useCourseProgress, false),
        includeAfter: payload.includeAfter || null,
        includeBefore: payload.includeBefore || null,
        progressZero: toBoolean(payload.progressZero, true),
        progressOneToFortyNine: toBoolean(payload.progressOneToFortyNine, true),
        progressFiftyToNinetyNine: toBoolean(payload.progressFiftyToNinetyNine, true),
        progressCompleted: toBoolean(payload.progressCompleted, true),
        excludeCourseId: payload.excludeCourseId || null,
      },
    },
  });

  return {
    sentAt,
    recipientsCount: uniqueUserIds.length,
    skippedCount: Math.max(enrollments.length - uniqueUserIds.length, 0),
  };
}
