import { prisma } from "../../shared/database/prisma.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { getPagination, toPagedResult } from "../../shared/utils/pagination.js";

let hasLoggedModelUnavailable = false;

function toTrimmed(value) {
  return String(value || "").trim();
}

function getActivityEventModel(optional = false) {
  if (prisma.activityEvent) return prisma.activityEvent;

  if (!optional) {
    throw new ApiError(
      500,
      "ActivityEvent model is unavailable. Run prisma generate and apply migrations.",
    );
  }

  if (!hasLoggedModelUnavailable) {
    hasLoggedModelUnavailable = true;
    console.warn(
      "[analytics] ActivityEvent model unavailable. Skipping event tracking until Prisma client is updated.",
    );
  }

  return null;
}

function buildActivityTitle(eventType) {
  switch (eventType) {
    case "AUTH_REGISTER":
      return "Created an account";
    case "AUTH_LOGIN":
      return "Signed in";
    case "ACCOUNT_PROFILE_UPDATED":
      return "Updated profile";
    case "LEARNING_LESSON_PROGRESS":
      return "Viewed a lesson";
    case "LEARNING_COURSE_COMPLETED":
      return "Completed a course";
    case "LEARNING_REVIEW_CREATED":
      return "Posted a course review";
    case "COMMERCE_CART_ADD":
      return "Added a course to cart";
    case "COMMERCE_WISHLIST_ADD":
      return "Added a course to wishlist";
    case "COMMERCE_CHECKOUT_CREATED":
      return "Started checkout";
    case "COMMERCE_PURCHASE_COMPLETED":
      return "Purchased a course";
    case "COURSE_IMPRESSION":
      return "Saw a course card";
    case "COURSE_PAGE_VIEW":
      return "Viewed a course page";
    default:
      return "Activity";
  }
}

export async function recordActivityEvent(payload) {
  const eventType = toTrimmed(payload?.eventType);
  if (!eventType) {
    throw new ApiError(400, "eventType is required");
  }

  const activityEvent = getActivityEventModel(true);
  if (!activityEvent) {
    return { created: false, skipped: true, reason: "MODEL_UNAVAILABLE" };
  }

  try {
    const userId = toTrimmed(payload?.userId) || null;
    const pagePath = toTrimmed(payload?.pagePath) || null;
    const sessionKey = toTrimmed(payload?.sessionKey) || null;
    const courseIdInput = toTrimmed(payload?.courseId);
    const courseSlug = toTrimmed(payload?.courseSlug);
    const dedupeWindowSeconds = Number(payload?.dedupeWindowSeconds || 0);

    let resolvedCourseId = courseIdInput || null;
    if (!resolvedCourseId && courseSlug) {
      const course = await prisma.course.findFirst({
        where: {
          slug: courseSlug,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!course) {
        throw new ApiError(404, "Course not found");
      }
      resolvedCourseId = course.id;
    }

    if (resolvedCourseId) {
      const course = await prisma.course.findFirst({
        where: {
          id: resolvedCourseId,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!course) {
        throw new ApiError(404, "Course not found");
      }
    }

    if (dedupeWindowSeconds > 0 && (userId || sessionKey)) {
      const threshold = new Date(Date.now() - dedupeWindowSeconds * 1000);
      const existing = await activityEvent.findFirst({
        where: {
          eventType,
          userId: userId || null,
          sessionKey: sessionKey || null,
          courseId: resolvedCourseId || null,
          pagePath,
          createdAt: { gte: threshold },
        },
        select: { id: true },
        orderBy: { createdAt: "desc" },
      });

      if (existing) {
        return { created: false, id: existing.id };
      }
    }

    const event = await activityEvent.create({
      data: {
        eventType,
        userId,
        courseId: resolvedCourseId,
        pagePath,
        sessionKey,
        metadata:
          payload?.metadata && typeof payload.metadata === "object"
            ? payload.metadata
            : undefined,
      },
      select: { id: true },
    });

    return { created: true, id: event.id };
  } catch (error) {
    console.warn(
      `[analytics] Failed to track event ${eventType}: ${error?.message || "Unknown error"}`,
    );
    return { created: false, skipped: true, reason: "WRITE_FAILED" };
  }
}

export async function listUserActivityEvents(userId, query = {}) {
  const activityEvent = getActivityEventModel(true);
  const { page, limit, skip } = getPagination(query);
  if (!activityEvent) {
    return toPagedResult([], 0, page, limit);
  }

  const where = { userId };
  const [rows, total] = await Promise.all([
    activityEvent.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        course: {
          select: {
            id: true,
            slug: true,
            title: true,
          },
        },
      },
    }),
    activityEvent.count({ where }),
  ]);

  const mapped = rows.map((row) => ({
    id: row.id,
    eventType: row.eventType,
    title: buildActivityTitle(row.eventType),
    pagePath: row.pagePath,
    createdAt: row.createdAt,
    course: row.course
      ? {
          id: row.course.id,
          slug: row.course.slug,
          title: row.course.title,
        }
      : null,
    metadata: row.metadata || null,
  }));

  return toPagedResult(mapped, total, page, limit);
}

async function getDistinctCount(activityEvent, where, field) {
  const rows = await activityEvent.findMany({
    where: {
      ...where,
      [field]: { not: null },
    },
    distinct: [field],
    select: { [field]: true },
  });
  return rows.length;
}

export async function getAdminActivityReport(query = {}) {
  const activityEvent = getActivityEventModel(true);
  const days = Number(query.days || 30);
  const boundedDays = Number.isFinite(days)
    ? Math.min(Math.max(Math.trunc(days), 1), 365)
    : 30;
  if (!activityEvent) {
    return {
      rangeDays: boundedDays,
      overview: {
        total_impressions: 0,
        total_page_views: 0,
        unique_impression_visitors: 0,
        unique_page_view_visitors: 0,
      },
      events: {
        auth_events: 0,
        learning_events: 0,
        commerce_events: 0,
      },
    };
  }

  const since = new Date(Date.now() - boundedDays * 24 * 60 * 60 * 1000);

  const impressionWhere = {
    eventType: "COURSE_IMPRESSION",
    createdAt: { gte: since },
  };
  const viewWhere = {
    eventType: "COURSE_PAGE_VIEW",
    createdAt: { gte: since },
  };

  const [totalImpressions, totalPageViews, uniqueImpressionUsers, uniqueImpressionSessions, uniqueViewUsers, uniqueViewSessions, authEvents, learningEvents, commerceEvents] =
    await Promise.all([
      activityEvent.count({ where: impressionWhere }),
      activityEvent.count({ where: viewWhere }),
      getDistinctCount(activityEvent, impressionWhere, "userId"),
      getDistinctCount(activityEvent, impressionWhere, "sessionKey"),
      getDistinctCount(activityEvent, viewWhere, "userId"),
      getDistinctCount(activityEvent, viewWhere, "sessionKey"),
      activityEvent.count({
        where: {
          createdAt: { gte: since },
          eventType: {
            in: ["AUTH_REGISTER", "AUTH_LOGIN"],
          },
        },
      }),
      activityEvent.count({
        where: {
          createdAt: { gte: since },
          eventType: {
            in: [
              "LEARNING_LESSON_PROGRESS",
              "LEARNING_COURSE_COMPLETED",
              "LEARNING_REVIEW_CREATED",
            ],
          },
        },
      }),
      activityEvent.count({
        where: {
          createdAt: { gte: since },
          eventType: {
            in: [
              "COMMERCE_CART_ADD",
              "COMMERCE_WISHLIST_ADD",
              "COMMERCE_CHECKOUT_CREATED",
              "COMMERCE_PURCHASE_COMPLETED",
            ],
          },
        },
      }),
    ]);

  return {
    rangeDays: boundedDays,
    overview: {
      total_impressions: totalImpressions,
      total_page_views: totalPageViews,
      unique_impression_visitors: Math.max(uniqueImpressionUsers, uniqueImpressionSessions),
      unique_page_view_visitors: Math.max(uniqueViewUsers, uniqueViewSessions),
    },
    events: {
      auth_events: authEvents,
      learning_events: learningEvents,
      commerce_events: commerceEvents,
    },
  };
}
