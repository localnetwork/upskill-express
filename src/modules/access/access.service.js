import { prisma } from "../../shared/database/prisma.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { getPlatformCommerceSettings } from "../platform-settings/platform-settings.service.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const PUBLISHED_COURSE = {
  deletedAt: null,
  OR: [{ workflowStatus: "PUBLISHED" }, { isPublished: true }],
};

// Learner access: ACTIVE/COMPLETED and not past its end date. Spread into a where clause.
export function activeEnrollmentFilter(now = new Date()) {
  return {
    status: { in: ["ACTIVE", "COMPLETED"] },
    OR: [{ accessEndsAt: null }, { accessEndsAt: { gt: now } }],
  };
}

async function getActiveSubscription(userId, now = new Date()) {
  return prisma.subscription.findFirst({
    where: {
      userId,
      OR: [
        {
          status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] },
          OR: [{ currentPeriodEnd: null }, { currentPeriodEnd: { gt: now } }],
        },
        // Canceled plans keep access until the paid period ends.
        { status: "CANCELED", currentPeriodEnd: { gt: now } },
      ],
    },
    include: { plan: true },
    orderBy: { createdAt: "desc" },
  });
}

export async function getAccessSummary(userId) {
  const now = new Date();
  const [settings, user, subscription, trialCourseCount] = await Promise.all([
    getPlatformCommerceSettings(),
    prisma.user.findUnique({
      where: { id: userId },
      select: { trialStartedAt: true, trialEndsAt: true },
    }),
    getActiveSubscription(userId, now),
    prisma.trialEvent.count({ where: { userId, type: "COURSE_ACCESSED" } }),
  ]);

  const trialActive = Boolean(user?.trialEndsAt && user.trialEndsAt > now);
  const trialUsed = Boolean(user?.trialStartedAt);
  const daysLeft = trialActive
    ? Math.max(1, Math.ceil((user.trialEndsAt.getTime() - now.getTime()) / DAY_MS))
    : 0;

  return {
    trial: {
      enabled: settings.trialEnabled,
      days: settings.trialDays,
      used: trialUsed,
      active: trialActive,
      startedAt: user?.trialStartedAt || null,
      endsAt: user?.trialEndsAt || null,
      daysLeft,
      coursesUsed: trialCourseCount,
      coursesMax: settings.trialMaxCoursesPerLearner,
    },
    subscription: subscription
      ? {
          id: subscription.id,
          status: subscription.status,
          planName: subscription.plan.name,
          interval: subscription.plan.interval,
          currentPeriodEnd: subscription.currentPeriodEnd,
          cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        }
      : null,
    hasSubscription: Boolean(subscription),
  };
}

export async function getCourseAccessOptions(userId, courseId) {
  const [course, enrollment, summary] = await Promise.all([
    prisma.course.findFirst({
      where: { id: courseId, ...PUBLISHED_COURSE },
      select: { id: true, trialEligible: true, subscriptionEligible: true },
    }),
    prisma.enrollment.findUnique({
      where: { userId_courseId: { userId, courseId } },
      select: { status: true, accessSource: true, accessEndsAt: true },
    }),
    getAccessSummary(userId),
  ]);
  if (!course) throw new ApiError(404, "Course not found");

  const now = new Date();
  const hasLiveAccess =
    Boolean(enrollment) &&
    ["ACTIVE", "COMPLETED"].includes(enrollment.status) &&
    (!enrollment.accessEndsAt || enrollment.accessEndsAt > now);

  return {
    enrollment: enrollment || null,
    hasLiveAccess,
    canUseSubscription:
      !hasLiveAccess && summary.hasSubscription && course.subscriptionEligible,
    canUseTrial:
      !hasLiveAccess &&
      !summary.hasSubscription &&
      summary.trial.active &&
      course.trialEligible &&
      summary.trial.coursesUsed < summary.trial.coursesMax,
    courseInSubscription: course.subscriptionEligible,
    courseInTrialPool: course.trialEligible,
    summary,
  };
}

// Opens a course using the learner's trial or subscription. Subscription wins when both apply.
export async function grantCourseAccess(userId, courseId) {
  const now = new Date();
  const [course, existing, summary, settings] = await Promise.all([
    prisma.course.findFirst({
      where: { id: courseId, ...PUBLISHED_COURSE },
      select: {
        id: true,
        educatorId: true,
        trialEligible: true,
        subscriptionEligible: true,
      },
    }),
    prisma.enrollment.findUnique({
      where: { userId_courseId: { userId, courseId } },
    }),
    getAccessSummary(userId),
    getPlatformCommerceSettings(),
  ]);
  if (!course) throw new ApiError(404, "Course not found");
  if (course.educatorId === userId) {
    throw new ApiError(400, "You cannot enroll in your own course");
  }

  if (existing?.accessSource === "PURCHASE") {
    return { enrollment: existing, source: "PURCHASE" };
  }
  if (
    existing &&
    ["ACTIVE", "COMPLETED"].includes(existing.status) &&
    (!existing.accessEndsAt || existing.accessEndsAt > now)
  ) {
    return { enrollment: existing, source: existing.accessSource };
  }

  let source = null;
  let accessEndsAt = null;
  if (summary.hasSubscription && course.subscriptionEligible) {
    source = "SUBSCRIPTION";
    accessEndsAt = summary.subscription.currentPeriodEnd;
  } else if (summary.trial.active && course.trialEligible) {
    if (summary.trial.coursesUsed >= settings.trialMaxCoursesPerLearner) {
      throw new ApiError(
        403,
        `Your trial includes up to ${settings.trialMaxCoursesPerLearner} courses.`,
      );
    }
    source = "TRIAL";
    accessEndsAt = summary.trial.endsAt;
  }
  if (!source) {
    throw new ApiError(
      403,
      "This course is not included in your trial or plan. Purchase it to start learning.",
    );
  }

  const enrollment = existing
    ? await prisma.enrollment.update({
        where: { id: existing.id },
        data: { status: "ACTIVE", accessSource: source, accessEndsAt },
      })
    : await prisma.enrollment.create({
        data: {
          userId,
          courseId,
          status: "ACTIVE",
          accessSource: source,
          accessEndsAt,
        },
      });

  if (source === "TRIAL") {
    const alreadyCounted = await prisma.trialEvent.findFirst({
      where: { userId, courseId, type: "COURSE_ACCESSED" },
      select: { id: true },
    });
    if (!alreadyCounted) {
      await prisma.trialEvent.create({
        data: { userId, courseId, type: "COURSE_ACCESSED" },
      });
    }
  }

  return { enrollment, source };
}

// Called when a subscription is renewed or cancelled so SUBSCRIPTION enrollments follow the period.
export async function syncSubscriptionEnrollments(userId, periodEnd) {
  return prisma.enrollment.updateMany({
    where: { userId, accessSource: "SUBSCRIPTION" },
    data: { accessEndsAt: periodEnd, status: "ACTIVE" },
  });
}

export async function expireLapsedEnrollments() {
  const now = new Date();
  const result = await prisma.enrollment.updateMany({
    where: {
      accessSource: { in: ["TRIAL", "SUBSCRIPTION"] },
      status: "ACTIVE",
      accessEndsAt: { lte: now },
    },
    data: { status: "EXPIRED" },
  });
  return result.count;
}

// Turns a trial/subscription enrollment into a purchased one and records a trial conversion.
export async function upgradeEnrollmentToPurchase(db, { userId, courseId, orderId, orderItemId }) {
  const existing = await db.enrollment.findUnique({
    where: { userId_courseId: { userId, courseId } },
  });
  if (!existing || existing.accessSource === "PURCHASE") return existing;

  const previousSource = existing.accessSource;
  const updated = await db.enrollment.update({
    where: { id: existing.id },
    data: {
      orderId,
      orderItemId: orderItemId || null,
      accessSource: "PURCHASE",
      accessEndsAt: null,
      status: existing.status === "COMPLETED" ? "COMPLETED" : "ACTIVE",
    },
  });

  if (previousSource === "TRIAL") {
    await db.trialEvent.create({
      data: { userId, courseId, type: "CONVERTED", metadata: { orderId } },
    });
  }
  return updated;
}
