import crypto from "crypto";
import { prisma } from "../../shared/database/prisma.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { createNotification } from "../notification/notification.service.js";
import { getPlatformCommerceSettings } from "../platform-settings/platform-settings.service.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_TRIALS_PER_IP_PER_MONTH = 3;
const DISPOSABLE_DOMAINS = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "10minutemail.com",
  "tempmail.com",
  "temp-mail.org",
  "yopmail.com",
  "trashmail.com",
  "sharklasers.com",
  "getnada.com",
  "throwawaymail.com",
  "dispostable.com",
  "maildrop.cc",
]);

function hashIp(ip) {
  return crypto.createHash("sha256").update(String(ip || "unknown")).digest("hex");
}

function isDisposableEmail(email) {
  const domain = String(email || "").split("@")[1]?.toLowerCase();
  return Boolean(domain && DISPOSABLE_DOMAINS.has(domain));
}

// Starts the free trial for a plain learner at signup. Never throws: signup must not fail because of it.
export async function startTrialIfEligible(userId, { ipAddress } = {}) {
  try {
    const settings = await getPlatformCommerceSettings();
    if (!settings.trialEnabled) return null;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        trialStartedAt: true,
        emailVerifiedAt: true,
        roles: { select: { role: { select: { name: true } } } },
      },
    });
    if (!user || user.trialStartedAt) return null;

    const roleNames = user.roles.map((entry) => entry.role.name);
    if (roleNames.length !== 1 || roleNames[0] !== "LEARNER") return null;
    if (isDisposableEmail(user.email)) return null;

    const ipHash = hashIp(ipAddress);
    if (ipAddress) {
      const recentTrials = await prisma.trialSignupFingerprint.count({
        where: { ipHash, createdAt: { gte: new Date(Date.now() - 30 * DAY_MS) } },
      });
      if (recentTrials >= MAX_TRIALS_PER_IP_PER_MONTH) return null;
    }

    const now = new Date();
    const endsAt = new Date(now.getTime() + settings.trialDays * DAY_MS);

    // updateMany keeps this idempotent if verification is triggered twice at once.
    const claimed = await prisma.user.updateMany({
      where: { id: userId, trialStartedAt: null },
      data: { trialStartedAt: now, trialEndsAt: endsAt },
    });
    if (claimed.count === 0) return null;

    await prisma.$transaction([
      prisma.entitlement.create({
        data: { userId, source: "TRIAL", startsAt: now, endsAt },
      }),
      prisma.trialEvent.create({ data: { userId, type: "STARTED" } }),
      prisma.trialSignupFingerprint.create({ data: { ipHash, userId } }),
    ]);

    await createNotification({
      userId,
      type: "SYSTEM",
      title: `Your ${settings.trialDays}-day free trial has started`,
      message:
        "Open any course in the Trial Pool and start learning. Your trial ends " +
        `on ${endsAt.toDateString()}.`,
      metadata: { trialEndsAt: endsAt.toISOString() },
    }).catch(() => null);

    return { startedAt: now, endsAt };
  } catch (error) {
    console.error("[trial] failed to start trial", error);
    return null;
  }
}

// Scheduled job: reminders on the last day, expiry events, and win-back messages after expiry.
export async function runTrialLifecycleJobs() {
  const now = new Date();
  const summary = { reminded: 0, expired: 0, winBack: 0 };

  const endingSoon = await prisma.user.findMany({
    where: { trialEndsAt: { gt: now, lte: new Date(now.getTime() + 2 * DAY_MS) } },
    select: { id: true, trialEndsAt: true },
  });
  for (const user of endingSoon) {
    const sent = await prisma.trialEvent.findFirst({
      where: { userId: user.id, type: "EXPIRED", metadata: { path: ["stage"], equals: "REMINDER" } },
      select: { id: true },
    });
    if (sent) continue;
    await prisma.trialEvent.create({
      data: { userId: user.id, type: "EXPIRED", metadata: { stage: "REMINDER" } },
    });
    await createNotification({
      userId: user.id,
      type: "SYSTEM",
      title: "Your free trial ends soon",
      message: "Buy a course or pick a plan to keep your progress and access.",
      metadata: { trialEndsAt: user.trialEndsAt.toISOString() },
    }).catch(() => null);
    summary.reminded += 1;
  }

  const lapsed = await prisma.user.findMany({
    where: { trialEndsAt: { lte: now, gt: new Date(now.getTime() - 3 * DAY_MS) } },
    select: { id: true },
  });
  for (const user of lapsed) {
    const sent = await prisma.trialEvent.findFirst({
      where: { userId: user.id, type: "EXPIRED", metadata: { path: ["stage"], equals: "LAPSED" } },
      select: { id: true },
    });
    if (sent) continue;
    await prisma.trialEvent.create({
      data: { userId: user.id, type: "EXPIRED", metadata: { stage: "LAPSED" } },
    });
    await createNotification({
      userId: user.id,
      type: "SYSTEM",
      title: "Your free trial has ended",
      message: "Your progress is saved. Purchase a course or subscribe to continue learning.",
    }).catch(() => null);
    summary.expired += 1;
  }

  return summary;
}

export async function getTrialFunnel() {
  const [started, accessed, converted, activeNow] = await Promise.all([
    prisma.trialEvent.count({ where: { type: "STARTED" } }),
    prisma.trialEvent.groupBy({ by: ["userId"], where: { type: "COURSE_ACCESSED" } }),
    prisma.trialEvent.groupBy({ by: ["userId"], where: { type: "CONVERTED" } }),
    prisma.user.count({ where: { trialEndsAt: { gt: new Date() } } }),
  ]);
  return {
    started,
    accessedCourse: accessed.length,
    converted: converted.length,
    activeNow,
    conversionRate: started ? Number(((converted.length / started) * 100).toFixed(1)) : 0,
  };
}

export async function extendUserTrial(userId, days) {
  const extra = Number(days);
  if (!Number.isFinite(extra) || extra < 1 || extra > 30) {
    throw new ApiError(400, "Extension must be between 1 and 30 days");
  }
  const identifier = String(userId || "").trim();
  const user = await prisma.user.findFirst({
    where: { OR: [{ id: identifier }, { email: identifier.toLowerCase() }], deletedAt: null },
    select: { id: true, trialStartedAt: true, trialEndsAt: true },
  });
  if (!user) throw new ApiError(404, "User not found");
  userId = user.id;
  if (!user.trialStartedAt) throw new ApiError(400, "This user has not started a trial");

  const base = user.trialEndsAt && user.trialEndsAt > new Date() ? user.trialEndsAt : new Date();
  const endsAt = new Date(base.getTime() + extra * DAY_MS);

  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { trialEndsAt: endsAt } }),
    prisma.entitlement.create({
      data: { userId, source: "ADMIN", startsAt: new Date(), endsAt },
    }),
    prisma.enrollment.updateMany({
      where: { userId, accessSource: "TRIAL" },
      data: { accessEndsAt: endsAt, status: "ACTIVE" },
    }),
  ]);
  return { userId, trialEndsAt: endsAt };
}
