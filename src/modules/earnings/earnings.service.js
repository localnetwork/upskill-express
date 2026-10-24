import { prisma } from "../../shared/database/prisma.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { getPagination, toPagedResult } from "../../shared/utils/pagination.js";
import { createNotification } from "../notification/notification.service.js";
import { getPlatformCommerceSettings } from "../platform-settings/platform-settings.service.js";

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
// A single heartbeat can credit at most this many seconds, so tabs left open do not inflate watch time.
export const MAX_HEARTBEAT_SECONDS = 35;
export const MAX_DAILY_WATCH_SECONDS = 6 * 60 * 60;

const round2 = (value) => Number(Number(value || 0).toFixed(2));

function toDay(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function monthKey(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function previousMonthKey(now = new Date()) {
  return monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
}

function monthRange(month) {
  if (!MONTH_PATTERN.test(String(month || ""))) {
    throw new ApiError(400, "Month must be formatted as YYYY-MM");
  }
  const [year, mon] = month.split("-").map(Number);
  return {
    start: new Date(Date.UTC(year, mon - 1, 1)),
    end: new Date(Date.UTC(year, mon, 1)),
  };
}

// Records learner watch time. Elapsed time is measured on the server, never trusted from the client.
export async function recordWatchHeartbeat(userId, lessonId) {
  const lesson = await prisma.lesson.findUnique({
    where: { id: String(lessonId) },
    select: { id: true, courseId: true, course: { select: { educatorId: true } } },
  });
  if (!lesson?.course) throw new ApiError(404, "Lesson not found");

  const now = new Date();
  const enrollment = await prisma.enrollment.findFirst({
    where: {
      userId,
      courseId: lesson.courseId,
      status: { in: ["ACTIVE", "COMPLETED"] },
      OR: [{ accessEndsAt: null }, { accessEndsAt: { gt: now } }],
    },
    select: { accessSource: true },
  });
  if (!enrollment) throw new ApiError(403, "Not enrolled in this course");
  if (lesson.course.educatorId === userId) return { counted: 0 };

  const day = toDay(now);
  const key = { userId_lessonId_day: { userId, lessonId: lesson.id, day } };
  const session = await prisma.watchSession.findUnique({ where: key });

  if (!session) {
    await prisma.watchSession.create({
      data: {
        userId,
        lessonId: lesson.id,
        courseId: lesson.courseId,
        educatorId: lesson.course.educatorId,
        day,
        seconds: 0,
        source: enrollment.accessSource,
        lastBeatAt: now,
      },
    });
    return { counted: 0 };
  }

  const elapsed = Math.floor((now.getTime() - session.lastBeatAt.getTime()) / 1000);
  const credited = Math.max(0, Math.min(elapsed, MAX_HEARTBEAT_SECONDS));

  const dayTotals = await prisma.watchSession.aggregate({
    where: { userId, day },
    _sum: { seconds: true },
  });
  const remaining = Math.max(0, MAX_DAILY_WATCH_SECONDS - (dayTotals._sum.seconds || 0));
  const counted = Math.min(credited, remaining);

  await prisma.watchSession.update({
    where: key,
    data: {
      seconds: { increment: counted },
      lastBeatAt: now,
      source: enrollment.accessSource,
    },
  });
  return { counted };
}

export async function recordTrialConversionEarning(db, { userId, courseId, previousSource }) {
  if (previousSource !== "TRIAL") return null;
  const settings = await getPlatformCommerceSettings();
  if (settings.trialConversionBonus <= 0) return null;

  const accessEvent = await db.trialEvent.findFirst({
    where: { userId, courseId, type: "COURSE_ACCESSED" },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true },
  });
  if (!accessEvent) return null;
  const windowEnd =
    accessEvent.createdAt.getTime() + settings.trialConversionWindowDays * 24 * 60 * 60 * 1000;
  if (Date.now() > windowEnd) return null;

  const course = await db.course.findUnique({
    where: { id: courseId },
    select: { educatorId: true },
  });
  if (!course) return null;

  const dedupeKey = `trial:${userId}:${courseId}`;
  const existing = await db.educatorEarning.findUnique({ where: { dedupeKey } });
  if (existing) return existing;

  return db.educatorEarning.create({
    data: {
      educatorId: course.educatorId,
      courseId,
      type: "TRIAL_CONVERSION",
      status: "AVAILABLE",
      amount: settings.trialConversionBonus,
      dedupeKey,
    },
  });
}

export async function calculateEarningsCycle(month) {
  const { start, end } = monthRange(month);
  const settings = await getPlatformCommerceSettings();

  const existing = await prisma.earningsCycle.findUnique({ where: { month } });
  if (existing?.status === "PUBLISHED") {
    throw new ApiError(409, "This cycle is already published and cannot be recalculated");
  }

  const [revenue, watch] = await Promise.all([
    prisma.subscriptionInvoice.aggregate({
      where: { status: "PAID", paidAt: { gte: start, lt: end } },
      _sum: { netAmount: true },
    }),
    prisma.watchSession.groupBy({
      by: ["educatorId"],
      where: { source: "SUBSCRIPTION", day: { gte: start, lt: end } },
      _sum: { seconds: true },
    }),
  ]);

  const netRevenue = round2(revenue._sum.netAmount || 0);
  const poolAmount = round2((netRevenue * settings.subscriptionPoolPercent) / 100);
  const totalSeconds = watch.reduce((sum, row) => sum + (row._sum.seconds || 0), 0);

  return prisma.$transaction(async (tx) => {
    const cycle = await tx.earningsCycle.upsert({
      where: { month },
      update: {
        status: "CALCULATED",
        netRevenue,
        poolPercent: settings.subscriptionPoolPercent,
        poolAmount,
        totalSeconds,
        calculatedAt: new Date(),
      },
      create: {
        month,
        status: "CALCULATED",
        netRevenue,
        poolPercent: settings.subscriptionPoolPercent,
        poolAmount,
        totalSeconds,
        calculatedAt: new Date(),
      },
    });

    // Recalculation replaces unpublished rows; published rows are never touched.
    await tx.educatorEarning.deleteMany({
      where: { cycleId: cycle.id, type: "SUBSCRIPTION_POOL", payoutRequestId: null },
    });

    if (poolAmount > 0 && totalSeconds > 0) {
      const rows = watch
        .filter((row) => (row._sum.seconds || 0) > 0)
        .map((row) => ({
          educatorId: row.educatorId,
          cycleId: cycle.id,
          type: "SUBSCRIPTION_POOL",
          status: "PENDING",
          seconds: row._sum.seconds,
          amount: round2((poolAmount * row._sum.seconds) / totalSeconds),
          dedupeKey: `pool:${month}:${row.educatorId}`,
        }));
      if (rows.length) await tx.educatorEarning.createMany({ data: rows });
    }

    return cycle;
  });
}

export async function publishEarningsCycle(month, adminId) {
  const cycle = await prisma.earningsCycle.findUnique({ where: { month } });
  if (!cycle) throw new ApiError(404, "Cycle not found. Calculate it first.");
  if (cycle.status === "PUBLISHED") throw new ApiError(409, "Cycle is already published");
  if (cycle.status !== "CALCULATED") throw new ApiError(400, "Calculate the cycle before publishing");

  const rows = await prisma.educatorEarning.findMany({
    where: { cycleId: cycle.id, status: "PENDING" },
    select: { educatorId: true, amount: true },
  });

  await prisma.$transaction([
    prisma.educatorEarning.updateMany({
      where: { cycleId: cycle.id, status: "PENDING" },
      data: { status: "AVAILABLE" },
    }),
    prisma.earningsCycle.update({
      where: { id: cycle.id },
      data: { status: "PUBLISHED", publishedAt: new Date(), publishedById: adminId || null },
    }),
  ]);

  await Promise.all(
    rows.map((row) =>
      createNotification({
        userId: row.educatorId,
        type: "PAYOUT",
        title: "Subscription earnings published",
        message: `Your ${month} subscription earnings of PHP ${round2(row.amount).toFixed(2)} are now available for payout.`,
        metadata: { month },
      }).catch(() => null),
    ),
  );

  return prisma.earningsCycle.findUnique({ where: { month } });
}

// Runs on a schedule: calculates last month once it has ended and is not yet calculated.
export async function autoCalculatePreviousCycle() {
  const month = previousMonthKey();
  const existing = await prisma.earningsCycle.findUnique({ where: { month } });
  if (existing) return null;
  return calculateEarningsCycle(month);
}

export async function listEarningsCycles({ page, limit } = {}) {
  const pagination = getPagination({ page, limit });
  const [rows, total] = await Promise.all([
    prisma.earningsCycle.findMany({
      orderBy: { month: "desc" },
      skip: pagination.skip,
      take: pagination.limit,
      include: { _count: { select: { earnings: true } } },
    }),
    prisma.earningsCycle.count(),
  ]);
  return toPagedResult(rows, total, pagination.page, pagination.limit);
}

export async function getEarningsCycleDetail(month) {
  const cycle = await prisma.earningsCycle.findUnique({ where: { month } });
  if (!cycle) throw new ApiError(404, "Cycle not found");
  const earnings = await prisma.educatorEarning.findMany({
    where: { cycleId: cycle.id },
    orderBy: { amount: "desc" },
    include: {
      educator: {
        select: { id: true, username: true, firstName: true, lastName: true, email: true },
      },
    },
  });
  return { cycle, earnings };
}

export async function getEducatorEarningsSummary(educatorId) {
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  const [byType, pendingRow, recent, watchByCourse, optedCourses, thisMonthWatch] =
    await Promise.all([
      prisma.educatorEarning.groupBy({
        by: ["type", "status"],
        where: { educatorId },
        _sum: { amount: true },
      }),
      prisma.educatorEarning.aggregate({
        where: { educatorId, status: "PENDING" },
        _sum: { amount: true },
      }),
      prisma.educatorEarning.findMany({
        where: { educatorId },
        orderBy: { createdAt: "desc" },
        take: 20,
        include: {
          cycle: { select: { month: true, status: true } },
          course: { select: { id: true, title: true } },
        },
      }),
      prisma.watchSession.groupBy({
        by: ["courseId"],
        where: { educatorId, source: "SUBSCRIPTION", day: { gte: monthStart } },
        _sum: { seconds: true },
      }),
      prisma.course.findMany({
        where: { educatorId, deletedAt: null, OR: [{ trialEligible: true }, { subscriptionEligible: true }] },
        select: { id: true, title: true, trialEligible: true, subscriptionEligible: true },
      }),
      prisma.watchSession.aggregate({
        where: { educatorId, source: "SUBSCRIPTION", day: { gte: monthStart } },
        _sum: { seconds: true },
      }),
    ]);

  const totals = { subscriptionPool: 0, trialConversion: 0, available: 0, paid: 0 };
  for (const row of byType) {
    const amount = round2(row._sum.amount || 0);
    if (row.type === "SUBSCRIPTION_POOL") totals.subscriptionPool += amount;
    else totals.trialConversion += amount;
    if (row.status === "AVAILABLE") totals.available += amount;
    if (row.status === "PAID") totals.paid += amount;
  }

  const titleById = new Map(optedCourses.map((c) => [c.id, c.title]));
  return {
    totals: {
      subscriptionPool: round2(totals.subscriptionPool),
      trialConversion: round2(totals.trialConversion),
      available: round2(totals.available),
      paid: round2(totals.paid),
      pending: round2(pendingRow._sum.amount || 0),
    },
    currentMonth: {
      watchMinutes: Math.round((thisMonthWatch._sum.seconds || 0) / 60),
      courses: watchByCourse.map((row) => ({
        courseId: row.courseId,
        title: titleById.get(row.courseId) || null,
        minutes: Math.round((row._sum.seconds || 0) / 60),
      })),
    },
    optedCourses,
    recent: recent.map((row) => ({
      id: row.id,
      type: row.type,
      status: row.status,
      amount: round2(row.amount),
      minutes: Math.round((row.seconds || 0) / 60),
      month: row.cycle?.month || null,
      courseTitle: row.course?.title || null,
      createdAt: row.createdAt,
    })),
  };
}

export async function getAvailableEducatorEarnings(db, educatorId) {
  return db.educatorEarning.findMany({
    where: { educatorId, status: "AVAILABLE", payoutRequestId: null },
    orderBy: { createdAt: "asc" },
  });
}

export async function setCourseProgramOptIn(educatorId, courseId, payload) {
  const course = await prisma.course.findFirst({
    where: { id: courseId, educatorId, deletedAt: null },
    select: { id: true, trialEligible: true, subscriptionEligible: true, isPublished: true, workflowStatus: true },
  });
  if (!course) throw new ApiError(404, "Course not found");

  const data = {};
  if (typeof payload.trialEligible === "boolean") data.trialEligible = payload.trialEligible;
  if (typeof payload.subscriptionEligible === "boolean") {
    data.subscriptionEligible = payload.subscriptionEligible;
  }

  if (data.trialEligible === true && !course.trialEligible) {
    const settings = await getPlatformCommerceSettings();
    const [published, inPool] = await Promise.all([
      prisma.course.count({
        where: { deletedAt: null, OR: [{ workflowStatus: "PUBLISHED" }, { isPublished: true }] },
      }),
      prisma.course.count({ where: { deletedAt: null, trialEligible: true } }),
    ]);
    const cap = Math.max(1, Math.floor((published * settings.trialPoolMaxPercent) / 100));
    if (inPool >= cap) {
      throw new ApiError(
        409,
        `The Trial Pool is full (${settings.trialPoolMaxPercent}% of the catalog). Try again later.`,
      );
    }
  }

  if (data.trialEligible || data.subscriptionEligible) data.trialOptInAt = new Date();

  return prisma.course.update({
    where: { id: courseId },
    data,
    select: { id: true, trialEligible: true, subscriptionEligible: true, trialOptInAt: true },
  });
}
