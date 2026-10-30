import { prisma } from "../../shared/database/prisma.js";
import axios from "axios";
import { ApiError } from "../../shared/utils/ApiError.js";
import { getPagination, toPagedResult } from "../../shared/utils/pagination.js";
import { createNotification } from "../notification/notification.service.js";
import { env } from "../../shared/config/env.js";
import { getPlatformCommerceSettings } from "../platform-settings/platform-settings.service.js";
import { recordActivityEvent } from "../analytics/analytics.service.js";
import { mapWithConcurrency } from "../../shared/utils/concurrency.js";
import { getAvailableEducatorEarnings } from "../earnings/earnings.service.js";
import { comparePassword } from "../../shared/utils/security.js";
import { verifyTotpToken } from "../auth/two-factor.service.js";
import {
  createXenditPayout,
  getXenditPayout,
  verifyXenditCallbackToken,
} from "../checkout/xendit.service.js";

const MIN_PAYOUT_AMOUNT_PHP = 500;
const PAYOUT_REVIEW_ESTIMATE_DAYS = 3;
const PAYOUT_APPROVED_ESTIMATE_DAYS = 1;
const PAYOUT_WITHDRAWAL_FEE_RATE = 0.02;
const payoutRequestItemsInclude = {
  events: {
    orderBy: { occurredAt: "asc" },
  },
  items: {
    include: {
      orderItem: {
        select: {
          id: true,
          createdAt: true,
          educatorEarning: true,
          totalAmount: true,
          order: {
            select: {
              id: true,
              createdAt: true,
              user: {
                select: {
                  id: true,
                  username: true,
                  email: true,
                  firstName: true,
                  lastName: true,
                },
              },
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
      },
    },
  },
};

async function appendPayoutEvent(
  payoutRequestId,
  eventType,
  payload = null,
  occurredAt = new Date(),
) {
  return prisma.payoutRequestEvent.create({
    data: {
      payoutRequestId,
      eventType,
      occurredAt,
      payload,
    },
  });
}

function getMonthBounds(now = new Date()) {
  const startOfCurrentMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return {
    startOfCurrentMonth,
    startOfNextMonth,
  };
}

function getWeekBounds(now = new Date()) {
  const date = new Date(now);
  const dayOfWeek = date.getDay();
  const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const startOfCurrentWeek = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate() + diffToMonday,
  );
  const startOfNextWeek = new Date(
    startOfCurrentWeek.getFullYear(),
    startOfCurrentWeek.getMonth(),
    startOfCurrentWeek.getDate() + 7,
  );
  return {
    startOfCurrentWeek,
    startOfNextWeek,
  };
}

function getDayBounds(now = new Date()) {
  const startOfCurrentDay = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  );
  const startOfNextDay = new Date(
    startOfCurrentDay.getFullYear(),
    startOfCurrentDay.getMonth(),
    startOfCurrentDay.getDate() + 1,
  );
  return {
    startOfCurrentDay,
    startOfNextDay,
  };
}

function getPayoutCycleWindow(payoutCycle, now = new Date()) {
  const normalizedCycle = String(payoutCycle || "ANYTIME").toUpperCase();
  if (normalizedCycle === "DAILY") {
    const { startOfCurrentDay, startOfNextDay } = getDayBounds(now);
    return {
      payoutCycle: "DAILY",
      eligibilityCutoff: startOfCurrentDay,
      periodStart: startOfCurrentDay,
      nextPayoutDate: startOfNextDay,
    };
  }
  if (normalizedCycle === "WEEKLY") {
    const { startOfCurrentWeek, startOfNextWeek } = getWeekBounds(now);
    return {
      payoutCycle: "WEEKLY",
      eligibilityCutoff: startOfCurrentWeek,
      periodStart: startOfCurrentWeek,
      nextPayoutDate: startOfNextWeek,
    };
  }
  if (normalizedCycle === "MONTHLY") {
    const { startOfCurrentMonth, startOfNextMonth } = getMonthBounds(now);
    return {
      payoutCycle: "MONTHLY",
      eligibilityCutoff: startOfCurrentMonth,
      periodStart: startOfCurrentMonth,
      nextPayoutDate: startOfNextMonth,
    };
  }
  return {
    payoutCycle: "ANYTIME",
    eligibilityCutoff: null,
    periodStart: null,
    nextPayoutDate: null,
  };
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function roundCurrency(value) {
  return Number(Number(value || 0).toFixed(2));
}

function allocateByWeights(totalAmount, weights = []) {
  const normalizedTotal = Math.max(0, roundCurrency(totalAmount));
  if (!Array.isArray(weights) || weights.length === 0 || normalizedTotal <= 0) {
    return (weights || []).map(() => 0);
  }

  const normalizedWeights = weights.map((weight) => Math.max(0, Number(weight || 0)));
  const totalWeight = normalizedWeights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight <= 0) {
    return normalizedWeights.map(() => 0);
  }

  const totalCents = Math.round(normalizedTotal * 100);
  const rawCents = normalizedWeights.map((weight) => (weight / totalWeight) * totalCents);
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

  return baseCents.map((value) => Number((value / 100).toFixed(2)));
}

function normalizeOrderItemsForPayout(rows = []) {
  const grouped = new Map();
  for (const row of rows) {
    const orderId = String(row?.orderId || row?.order?.id || "");
    if (!orderId) continue;
    if (!grouped.has(orderId)) grouped.set(orderId, []);
    grouped.get(orderId).push(row);
  }

  const normalizedByItemId = new Map();

  for (const groupRows of grouped.values()) {
    const orderDiscountAmount = roundCurrency(
      Number(groupRows[0]?.order?.discountAmount || 0),
    );

    const explicitDiscountByIndex = groupRows.map((row) =>
      roundCurrency(Number(row?.discountAmount || 0)),
    );
    const explicitDiscountSum = roundCurrency(
      explicitDiscountByIndex.reduce((sum, value) => sum + value, 0),
    );
    const remainingOrderDiscount = roundCurrency(
      Math.max(0, orderDiscountAmount - explicitDiscountSum),
    );

    const allocationTargets = groupRows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => Number(row?.discountAmount || 0) <= 0);

    const allocatedDiscounts = new Map();
    if (remainingOrderDiscount > 0 && allocationTargets.length > 0) {
      const allocations = allocateByWeights(
        remainingOrderDiscount,
        allocationTargets.map(({ row }) => Number(row?.unitPrice || 0)),
      );
      for (let index = 0; index < allocationTargets.length; index += 1) {
        allocatedDiscounts.set(allocationTargets[index].index, Number(allocations[index] || 0));
      }
    }

    groupRows.forEach((row, index) => {
      const unitPrice = roundCurrency(Number(row?.unitPrice || 0));
      const itemDiscountAmount = roundCurrency(
        Math.min(
          unitPrice,
          Number(explicitDiscountByIndex[index] || 0) +
            Number(allocatedDiscounts.get(index) || 0),
        ),
      );
      const payoutTaxableAmount = roundCurrency(
        Math.max(0, unitPrice - itemDiscountAmount),
      );
      const platformFeePercent = Number(row?.platformFeePercent || 0);
      const payoutPlatformFeeAmount = roundCurrency(
        (payoutTaxableAmount * platformFeePercent) / 100,
      );
      const payoutEducatorAmount = roundCurrency(
        Math.max(0, payoutTaxableAmount - payoutPlatformFeeAmount),
      );

      normalizedByItemId.set(row.id, {
        ...row,
        payoutDiscountAmount: itemDiscountAmount,
        payoutTaxableAmount,
        payoutPlatformFeeAmount,
        payoutEducatorAmount,
      });
    });
  }

  return rows.map((row) => normalizedByItemId.get(row.id) || row);
}

function buildPayoutCycleProgress({
  hasVerifiedPayoutAccount,
  availableBalance,
  minimumPayoutAmount,
  currentMonthRequest,
}) {
  const requestStatus = currentMonthRequest?.status || null;
  const hasMinimumBalance = availableBalance >= minimumPayoutAmount;
  const hasSubmittedRequest = Boolean(currentMonthRequest);
  const isApproved = requestStatus === "APPROVED";
  const isExecuted = requestStatus === "EXECUTED";

  let currentStepKey = "CONNECT_PAYOUT_ACCOUNT";
  if (isExecuted) {
    currentStepKey = "PAYOUT_RELEASED";
  } else if (isApproved) {
    currentStepKey = "PAYOUT_RELEASED";
  } else if (requestStatus === "REQUESTED") {
    currentStepKey = "UNDER_REVIEW";
  } else if (hasVerifiedPayoutAccount && hasMinimumBalance) {
    currentStepKey = "SUBMIT_PAYOUT_REQUEST";
  } else if (hasVerifiedPayoutAccount) {
    currentStepKey = "REACH_MINIMUM_BALANCE";
  }

  const steps = [
    {
      key: "CONNECT_PAYOUT_ACCOUNT",
      label: "Connect payout account",
      completed: hasVerifiedPayoutAccount,
    },
    {
      key: "REACH_MINIMUM_BALANCE",
      label: "Reach minimum payout balance",
      completed: hasMinimumBalance,
      meta: {
        minimumPayoutAmount,
        currentAvailableBalance: Number(availableBalance.toFixed(2)),
      },
    },
    {
      key: "SUBMIT_PAYOUT_REQUEST",
      label: "Submit payout request",
      completed: hasSubmittedRequest,
      completedAt: currentMonthRequest?.requestedAt || null,
    },
    {
      key: "UNDER_REVIEW",
      label: "Admin review",
      completed: ["APPROVED", "EXECUTED"].includes(String(requestStatus || "")),
      completedAt:
        requestStatus === "APPROVED" || requestStatus === "EXECUTED"
          ? currentMonthRequest?.reviewedAt || null
          : null,
    },
    {
      key: "PAYOUT_RELEASED",
      label: "Payout released",
      completed: isExecuted,
      completedAt: isExecuted ? currentMonthRequest?.executedAt || null : null,
    },
  ];

  const completedSteps = steps.filter((step) => step.completed).length;
  const progressPercent = Math.round((completedSteps / steps.length) * 100);

  return {
    steps: steps.map((step) => ({
      ...step,
      current: step.key === currentStepKey,
    })),
    currentStepKey,
    completedSteps,
    totalSteps: steps.length,
    progressPercent,
  };
}

function buildPayoutEstimate({
  now,
  nextPayoutDate,
  payoutCycle,
  hasVerifiedPayoutAccount,
  availableBalance,
  minimumPayoutAmount,
  currentMonthRequest,
}) {
  const requestStatus = currentMonthRequest?.status || null;

  if (requestStatus === "EXECUTED") {
    return {
      waitingOn: "NONE",
      earliestRequestAt: currentMonthRequest?.requestedAt || now,
      estimatedPayoutAt: currentMonthRequest?.executedAt || now,
      processingDays: 0,
      message: "Payout was already released to Xendit.",
    };
  }

  if (requestStatus === "APPROVED") {
    const estimatedPayoutAt = addDays(now, PAYOUT_APPROVED_ESTIMATE_DAYS);
    return {
      waitingOn: "XENDIT_PROCESSING",
      earliestRequestAt: currentMonthRequest?.requestedAt || now,
      estimatedPayoutAt,
      processingDays: PAYOUT_APPROVED_ESTIMATE_DAYS,
      message: "Payout is approved and should be released shortly.",
    };
  }

  if (requestStatus === "REQUESTED") {
    const requestAt = currentMonthRequest?.requestedAt || now;
    return {
      waitingOn: "ADMIN_REVIEW",
      earliestRequestAt: requestAt,
      estimatedPayoutAt: addDays(requestAt, PAYOUT_REVIEW_ESTIMATE_DAYS),
      processingDays: PAYOUT_REVIEW_ESTIMATE_DAYS,
      message: "Payout request is queued for admin review.",
    };
  }

  if (String(payoutCycle || "").toUpperCase() === "ANYTIME") {
    if (!hasVerifiedPayoutAccount) {
      return {
        waitingOn: "ACCOUNT_VERIFICATION",
        earliestRequestAt: null,
        estimatedPayoutAt: null,
        processingDays: PAYOUT_REVIEW_ESTIMATE_DAYS,
        message: "Connect a verified payout account to start receiving payouts.",
      };
    }

    if (availableBalance < minimumPayoutAmount) {
      return {
        waitingOn: "MINIMUM_BALANCE",
        earliestRequestAt: null,
        estimatedPayoutAt: null,
        processingDays: PAYOUT_REVIEW_ESTIMATE_DAYS,
        message: "No fixed payout date for Anytime cycle until minimum balance is reached.",
      };
    }

    return {
      waitingOn: "NONE",
      earliestRequestAt: null,
      estimatedPayoutAt: null,
      processingDays: PAYOUT_REVIEW_ESTIMATE_DAYS,
      message: "You can request payout anytime.",
    };
  }

  if (!hasVerifiedPayoutAccount) {
    const hasMinimumBalance = availableBalance >= minimumPayoutAmount;
    const earliestRequestAt = hasMinimumBalance ? now : nextPayoutDate || now;
    return {
      waitingOn: "ACCOUNT_VERIFICATION",
      earliestRequestAt,
      estimatedPayoutAt: addDays(
        earliestRequestAt,
        PAYOUT_REVIEW_ESTIMATE_DAYS,
      ),
      processingDays: PAYOUT_REVIEW_ESTIMATE_DAYS,
      message: "Connect a verified payout account to start receiving payouts.",
    };
  }

  if (availableBalance < minimumPayoutAmount) {
    const baselineDate = nextPayoutDate || now;
    return {
      waitingOn: "MINIMUM_BALANCE",
      earliestRequestAt: baselineDate,
      estimatedPayoutAt: addDays(baselineDate, PAYOUT_REVIEW_ESTIMATE_DAYS),
      processingDays: PAYOUT_REVIEW_ESTIMATE_DAYS,
      message:
        "Estimated date assumes your next cycle reaches minimum payout balance.",
    };
  }

  return {
    waitingOn: "NONE",
    earliestRequestAt: now,
    estimatedPayoutAt: addDays(now, PAYOUT_REVIEW_ESTIMATE_DAYS),
    processingDays: PAYOUT_REVIEW_ESTIMATE_DAYS,
    message: "If requested now, payout is typically released in a few days.",
  };
}

function isSkippableAutoPayoutError(error) {
  if (!(error instanceof ApiError)) return false;
  const message = String(error.message || "");
  return (
    message.includes("A payout request for this") ||
    message.includes("No payout-eligible earnings yet") ||
    message.includes("Minimum payout is PHP") ||
    message.includes("No eligible earnings for requested amount")
  );
}

const XENDIT_PAYOUT_PROCESSING_STATUSES = new Set([
  "ACCEPTED",
  "REQUESTED",
  "LOCKED",
  "PROCESSING",
]);
const XENDIT_PAYOUT_FAILED_STATUSES = new Set([
  "FAILED",
  "CANCELLED",
  "REVERSED",
]);

function getXenditErrorMessage(error) {
  const details = error?.response?.data;
  if (details?.message) {
    return String(details.message);
  }
  return error instanceof Error ? error.message : "Unknown Xendit error";
}

function mapXenditPayoutStatusToMutation(rawStatus, failureCode) {
  const status = String(rawStatus || "").toUpperCase();

  if (status === "SUCCEEDED") {
    return {
      status: "EXECUTED",
      reviewNote: null,
      eventType: "PAYMENT.PAYOUTSBATCH.SUCCESS",
      webhookStatus: status,
      shouldNotifyPaid: true,
    };
  }

  if (XENDIT_PAYOUT_PROCESSING_STATUSES.has(status)) {
    return {
      status: "EXECUTED",
      reviewNote: `Xendit payout status: ${status}`,
      eventType: "PAYMENT.PAYOUTSBATCH.PROCESSING",
      webhookStatus: status,
      shouldNotifyPaid: false,
    };
  }

  if (XENDIT_PAYOUT_FAILED_STATUSES.has(status)) {
    return {
      status: "FAILED",
      reviewNote: `Xendit payout status: ${status}${failureCode ? ` (${failureCode})` : ""}`,
      eventType: "PAYMENT.PAYOUTS-ITEM.FAILED",
      webhookStatus: status,
      shouldNotifyPaid: false,
    };
  }

  return null;
}

export async function handleXenditPayoutWebhook(event, headers = {}) {
  if (!verifyXenditCallbackToken(headers?.["x-callback-token"])) {
    throw new ApiError(401, "Invalid Xendit callback token");
  }

  const data = event?.data || {};
  if (!String(event?.event || "").startsWith("payout.")) {
    return { accepted: true, ignored: true };
  }

  const mutation = mapXenditPayoutStatusToMutation(
    data.status,
    data.failure_code,
  );
  if (!mutation) {
    return { accepted: true, ignored: true };
  }

  const xenditPayoutId = data.id ? String(data.id) : null;
  let payout = null;
  if (xenditPayoutId) {
    payout = await prisma.payoutRequest.findFirst({
      where: { xenditPayoutId },
      orderBy: { createdAt: "desc" },
    });
  }
  if (!payout && data.reference_id) {
    // Retries append a suffix to the payout request id.
    payout = await prisma.payoutRequest.findUnique({
      where: { id: String(data.reference_id).split(":")[0] },
    });
  }

  if (!payout) {
    return {
      accepted: true,
      ignored: true,
      reason: "Payout request not found for webhook event",
    };
  }

  const occurredAt = event?.created ? new Date(event.created) : new Date();
  const updated = await prisma.payoutRequest.update({
    where: { id: payout.id },
    data: {
      status: mutation.status,
      reviewNote: mutation.reviewNote,
      xenditPayoutId: payout.xenditPayoutId || xenditPayoutId,
      executedAt:
        mutation.status === "EXECUTED" && !mutation.reviewNote
          ? payout.executedAt || new Date()
          : payout.executedAt,
    },
  });
  if (mutation.shouldNotifyPaid) {
    await prisma.educatorEarning.updateMany({
      where: { payoutRequestId: updated.id },
      data: { status: "PAID" },
    });
  }
  await appendPayoutEvent(
    updated.id,
    mutation.eventType,
    {
      webhookEvent: event?.event || null,
      webhookStatus: mutation.webhookStatus,
      failureCode: data.failure_code || null,
      xenditPayoutId,
      source: "webhook",
    },
    Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt,
  );

  if (mutation.shouldNotifyPaid) {
    await createNotification({
      userId: updated.educatorId,
      type: "PAYOUT",
      title: "Payout paid",
      message: `Your payout request ${updated.id} has been paid.`,
      metadata: {
        payoutRequestId: updated.id,
        xenditPayoutId: updated.xenditPayoutId,
        webhookStatus: mutation.webhookStatus,
      },
    });
  }

  if (mutation.status === "FAILED") {
    await createNotification({
      userId: updated.educatorId,
      type: "PAYOUT",
      title: "Payout failed",
      message: `Your payout request ${updated.id} could not be completed.`,
      metadata: {
        payoutRequestId: updated.id,
        xenditPayoutId: updated.xenditPayoutId,
        webhookStatus: mutation.webhookStatus,
      },
    });
  }

  return { accepted: true, payoutRequestId: updated.id, status: updated.status };
}

async function refreshExecutedPayoutStatus(payout) {
  if (String(payout?.status || "").toUpperCase() !== "EXECUTED") {
    return payout;
  }
  if (!payout?.xenditPayoutId) {
    return payout;
  }

  try {
    const remote = await getXenditPayout(payout.xenditPayoutId);
    const mutation = mapXenditPayoutStatusToMutation(
      remote?.status,
      remote?.failure_code,
    );
    if (!mutation) return payout;
    if (mutation.status === "EXECUTED" && payout.reviewNote === mutation.reviewNote) {
      return payout;
    }

    const updated = await prisma.payoutRequest.update({
      where: { id: payout.id },
      data: {
        status: mutation.status,
        reviewNote: mutation.reviewNote,
      },
      include: {
        ...payoutRequestItemsInclude,
        educator: {
          select: { id: true, username: true, email: true },
        },
      },
    });
    await appendPayoutEvent(updated.id, mutation.eventType, {
      xenditStatus: mutation.webhookStatus,
      failureCode: remote?.failure_code || null,
      source: "polling",
    });
    return updated;
  } catch (error) {
    console.error("[payout-status-refresh] failed", {
      payoutRequestId: payout.id,
      xenditPayoutId: payout.xenditPayoutId,
      message: error instanceof Error ? error.message : "Unknown error",
    });
    return payout;
  }
}

function resolveVerificationMethod(user) {
  if (user.twoFactorEnabled && user.twoFactorSecret) return "authenticator";
  return user.passwordSet ? "password" : "none";
}

const VERIFY_USER_SELECT = {
  passwordHash: true,
  passwordSet: true,
  twoFactorEnabled: true,
  twoFactorSecret: true,
};

export async function getAccountVerificationMethod(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: VERIFY_USER_SELECT,
  });
  if (!user) throw new ApiError(404, "User not found");
  return { method: resolveVerificationMethod(user) };
}

export async function verifyAccountOwnership(userId, { password, code } = {}) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: VERIFY_USER_SELECT,
  });
  if (!user) throw new ApiError(404, "User not found");
  const method = resolveVerificationMethod(user);
  if (method === "authenticator") {
    if (!/^\d{6}$/.test(String(code || "")) || !verifyTotpToken(user.twoFactorSecret, String(code))) {
      throw new ApiError(401, "Invalid authenticator code");
    }
  } else if (method === "password") {
    const valid = await comparePassword(String(password || ""), user.passwordHash);
    if (!valid) throw new ApiError(401, "Incorrect password");
  }
  return { verified: true, method };
}

export async function connectPayoutAccount(userId, payload) {
  const existing = await prisma.payoutAccount.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (existing) await verifyAccountOwnership(userId, payload);
  const data = {
    channelCode: payload.channelCode,
    accountNumber: payload.accountNumber,
    accountHolderName: payload.accountHolderName,
    isVerified: true,
  };
  return prisma.payoutAccount.upsert({
    where: { userId },
    update: data,
    create: { userId, ...data },
  });
}

async function getAvailableOrderItems(educatorId, eligibilityCutoff) {
  const rows = await prisma.orderItem.findMany({
    where: {
      educatorId,
      createdAt: eligibilityCutoff ? { lt: eligibilityCutoff } : undefined,
      order: {
        is: {
          status: "PAID",
        },
      },
      payoutItems: {
        none: {},
      },
    },
    include: {
      order: {
        select: {
          id: true,
          discountAmount: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  return normalizeOrderItemsForPayout(rows);
}

// Subscription/trial earnings enter the payout flow as pseudo order items.
async function getAvailableEarningItems(educatorId) {
  const rows = await getAvailableEducatorEarnings(prisma, educatorId);
  return rows.map((row) => ({
    id: row.id,
    kind: "EARNING",
    earningType: row.type,
    unitPrice: Number(row.amount),
    discountAmount: 0,
    payoutPlatformFeeAmount: 0,
    payoutEducatorAmount: Number(row.amount),
  }));
}

export async function getMyPayoutSummary(educatorId) {
  const now = new Date();
  const settings = await getPlatformCommerceSettings();
  const cycleWindow = getPayoutCycleWindow(settings.payoutCycle, now);
  const eligibilityCutoff = cycleWindow.eligibilityCutoff;
  const periodStart = cycleWindow.periodStart;

  const [
    payoutAccount,
    eligibleItems,
    currentMonthItems,
    currentMonthRequest,
    latestPayout,
  ] = await Promise.all([
    prisma.payoutAccount.findUnique({
      where: { userId: educatorId },
    }),
    getAvailableOrderItems(educatorId, eligibilityCutoff),
    prisma.orderItem.findMany({
      where: {
        educatorId,
        createdAt: eligibilityCutoff ? { gte: eligibilityCutoff } : undefined,
        order: {
          is: {
            status: "PAID",
          },
        },
        payoutItems: {
          none: {},
        },
      },
      select: {
        id: true,
        orderId: true,
        unitPrice: true,
        discountAmount: true,
        platformFeePercent: true,
        order: {
          select: {
            id: true,
            discountAmount: true,
          },
        },
      },
    }),
    prisma.payoutRequest.findFirst({
      where: {
        educatorId,
        requestedAt: periodStart ? { gte: periodStart } : undefined,
        status: {
          in: ["REQUESTED", "APPROVED", "EXECUTED"],
        },
      },
      orderBy: {
        requestedAt: "desc",
      },
      select: {
        id: true,
        status: true,
        amount: true,
        requestedAt: true,
        reviewedAt: true,
        executedAt: true,
      },
    }),
    prisma.payoutRequest.findFirst({
      where: { educatorId },
      orderBy: {
        requestedAt: "desc",
      },
      select: {
        id: true,
        status: true,
        amount: true,
        requestedAt: true,
        executedAt: true,
      },
    }),
  ]);

  const earningItems = await getAvailableEarningItems(educatorId);
  const sumEarnings = (type) =>
    Number(
      earningItems
        .filter((item) => item.earningType === type)
        .reduce((sum, item) => sum + item.payoutEducatorAmount, 0)
        .toFixed(2),
    );
  const subscriptionPoolBalance = sumEarnings("SUBSCRIPTION_POOL");
  const earningsBalance = Number(
    earningItems.reduce((sum, item) => sum + item.payoutEducatorAmount, 0).toFixed(2),
  );
  const salesBalance = (eligibleItems || []).reduce(
    (sum, item) => sum + Number(item?.payoutEducatorAmount || 0),
    0,
  );
  const availableBalance = Number((salesBalance + earningsBalance).toFixed(2));
  const normalizedCurrentMonthItems = normalizeOrderItemsForPayout(currentMonthItems || []);
  const thisMonthEarnings = Number(
    normalizedCurrentMonthItems
      .reduce((sum, item) => sum + Number(item?.payoutEducatorAmount || 0), 0)
      .toFixed(2),
  );
  const hasVerifiedPayoutAccount = Boolean(payoutAccount?.isVerified);

  const nextPayoutDate = cycleWindow.nextPayoutDate;
  const payoutCycleProgress = buildPayoutCycleProgress({
    hasVerifiedPayoutAccount,
    availableBalance,
    minimumPayoutAmount: MIN_PAYOUT_AMOUNT_PHP,
    currentMonthRequest,
  });
  const payoutEstimate = buildPayoutEstimate({
    now,
    nextPayoutDate,
    payoutCycle: cycleWindow.payoutCycle,
    hasVerifiedPayoutAccount,
    availableBalance,
    minimumPayoutAmount: MIN_PAYOUT_AMOUNT_PHP,
    currentMonthRequest,
  });

  let cannotRequestReason = "";
  if (!hasVerifiedPayoutAccount) {
    cannotRequestReason = "Connect and verify a Xendit payout account first.";
  } else if (periodStart && currentMonthRequest) {
    cannotRequestReason = `You already have a payout request for this ${cycleWindow.payoutCycle.toLowerCase()} cycle.`;
  } else if (availableBalance < MIN_PAYOUT_AMOUNT_PHP) {
    cannotRequestReason = `Minimum payout is PHP ${MIN_PAYOUT_AMOUNT_PHP.toFixed(2)}.`;
  }

  return {
    minimumPayoutAmount: MIN_PAYOUT_AMOUNT_PHP,
    withdrawalFeeRate: PAYOUT_WITHDRAWAL_FEE_RATE,
    currency: env.xenditPayoutCurrency,
    payoutCycle: cycleWindow.payoutCycle,
    availableBalance: Number(availableBalance.toFixed(2)),
    salesBalance: Number(salesBalance.toFixed(2)),
    subscriptionEarningsBalance: subscriptionPoolBalance,
    thisMonthEarnings: Number(thisMonthEarnings.toFixed(2)),
    hasVerifiedPayoutAccount,
    canRequestPayout: cannotRequestReason.length === 0,
    cannotRequestReason,
    payoutAccount: payoutAccount
      ? {
          channelCode: payoutAccount.channelCode,
          accountNumber: payoutAccount.accountNumber,
          accountHolderName: payoutAccount.accountHolderName,
          isVerified: payoutAccount.isVerified,
          updatedAt: payoutAccount.updatedAt,
        }
      : null,
    currentMonthRequest,
    latestPayout,
    nextPayoutDate,
    payoutCycleProgress,
    payoutEstimate,
  };
}

export async function requestPayout(educatorId, payload) {
  const settings = await getPlatformCommerceSettings();
  const cycleWindow = getPayoutCycleWindow(settings.payoutCycle);
  const periodStart = cycleWindow.periodStart;
  const payoutAccount = await prisma.payoutAccount.findUnique({
    where: { userId: educatorId },
  });

  if (!payoutAccount || !payoutAccount.isVerified) {
    throw new ApiError(400, "Connect and verify Xendit payout account first");
  }

  const existingMonthRequest = await prisma.payoutRequest.findFirst({
    where: {
      educatorId,
      requestedAt: periodStart ? { gte: periodStart } : undefined,
      status: {
        in: ["REQUESTED", "APPROVED", "EXECUTED"],
      },
    },
    select: { id: true },
  });

  if (periodStart && existingMonthRequest) {
    throw new ApiError(
      400,
      `A payout request for this ${cycleWindow.payoutCycle.toLowerCase()} cycle already exists`,
    );
  }

  const [saleItems, earningItems] = await Promise.all([
    getAvailableOrderItems(educatorId, cycleWindow.eligibilityCutoff),
    getAvailableEarningItems(educatorId),
  ]);
  const items = [...saleItems, ...earningItems];
  if (items.length === 0) {
    throw new ApiError(
      400,
      cycleWindow.payoutCycle === "ANYTIME"
        ? "No payout-eligible earnings yet."
        : `No payout-eligible earnings yet. Payouts include sales before the current ${cycleWindow.payoutCycle.toLowerCase()} period.`,
    );
  }

  const desiredAmount = payload.amount || null;
  if (desiredAmount && Number(desiredAmount) < MIN_PAYOUT_AMOUNT_PHP) {
    throw new ApiError(
      400,
      `Minimum payout is PHP ${MIN_PAYOUT_AMOUNT_PHP.toFixed(2)}`,
    );
  }

  const selected = [];
  let running = 0;
  for (const item of items) {
    const itemEarning = Number(item?.payoutEducatorAmount || 0);
    const nextAmount = running + itemEarning;
    if (desiredAmount && nextAmount > desiredAmount && selected.length > 0) {
      break;
    }
    selected.push(item);
    running = nextAmount;
    if (desiredAmount && running >= desiredAmount) {
      break;
    }
  }

  const grossPayoutAmount = Number(running.toFixed(2));
  const sumSelected = (predicate) =>
    Number(
      selected
        .filter(predicate)
        .reduce((sum, item) => sum + Number(item?.payoutEducatorAmount || 0), 0)
        .toFixed(2),
    );
  if (grossPayoutAmount <= 0) {
    throw new ApiError(400, "No eligible earnings for requested amount");
  }
  if (grossPayoutAmount < MIN_PAYOUT_AMOUNT_PHP) {
    throw new ApiError(
      400,
      `Minimum payout is PHP ${MIN_PAYOUT_AMOUNT_PHP.toFixed(2)}`,
    );
  }
  const withdrawalFeeAmount = Number(
    (grossPayoutAmount * PAYOUT_WITHDRAWAL_FEE_RATE).toFixed(2),
  );
  const payoutAmount = Number(
    Math.max(grossPayoutAmount - withdrawalFeeAmount, 0).toFixed(2),
  );
  if (payoutAmount <= 0) {
    throw new ApiError(400, "Payout amount is too low after withdrawal fee");
  }

  const request = await prisma.$transaction(async (tx) => {
    const now = new Date();
    const payout = await tx.payoutRequest.create({
      data: {
        educatorId,
        amount: payoutAmount,
        currency: env.xenditPayoutCurrency,
        status: "APPROVED",
        reviewedAt: now,
        reviewNote: "Auto-approved payout request",
        note: payload.note || null,
        calculationSnapshot: {
          orderItemIds: selected
            .filter((item) => item.kind !== "EARNING")
            .map((item) => item.id),
          earningIds: selected
            .filter((item) => item.kind === "EARNING")
            .map((item) => item.id),
          gross: selected.reduce(
            (sum, item) => sum + Number(item.unitPrice),
            0,
          ),
          discounts: selected.reduce(
            (sum, item) => sum + Number(item.discountAmount || 0),
            0,
          ),
          platformFees: selected.reduce(
            (sum, item) => sum + Number(item.payoutPlatformFeeAmount || 0),
            0,
          ),
          educatorEarnings: grossPayoutAmount,
          breakdown: {
            sales: sumSelected((item) => item.kind !== "EARNING"),
            subscriptionPool: sumSelected((item) => item.earningType === "SUBSCRIPTION_POOL"),
          },
          grossPayoutAmount,
          withdrawalFeeRate: PAYOUT_WITHDRAWAL_FEE_RATE,
          withdrawalFeeAmount,
          netPayoutAmount: payoutAmount,
          minimumPayoutAmount: MIN_PAYOUT_AMOUNT_PHP,
          payoutRule:
            cycleWindow.payoutCycle === "ANYTIME"
              ? "ANYTIME_AVAILABLE_EARNINGS"
              : `${cycleWindow.payoutCycle}_PREVIOUS_PERIOD`,
        },
      },
    });

    const selectedEarningIds = selected
      .filter((item) => item.kind === "EARNING")
      .map((item) => item.id);
    if (selectedEarningIds.length > 0) {
      await tx.educatorEarning.updateMany({
        where: { id: { in: selectedEarningIds }, payoutRequestId: null },
        data: { payoutRequestId: payout.id },
      });
    }

    for (const item of selected.filter((entry) => entry.kind !== "EARNING")) {
      await tx.payoutRequestItem.create({
        data: {
          payoutRequestId: payout.id,
          orderItemId: item.id,
          amount: Number(item.payoutEducatorAmount || 0),
        },
      });
    }
    await tx.payoutRequestEvent.createMany({
      data: [
        {
          payoutRequestId: payout.id,
          eventType: "PAYOUT.REQUESTED",
          occurredAt: now,
          payload: {
            payoutCycle: cycleWindow.payoutCycle,
            autoApproved: true,
          },
        },
        {
          payoutRequestId: payout.id,
          eventType: "PAYOUT.APPROVED",
          occurredAt: now,
          payload: {
            autoApproved: true,
            reviewNote: "Auto-approved payout request",
          },
        },
      ],
    });

    return payout;
  });

  await recordActivityEvent({
    eventType: "INSTRUCTOR_PAYOUT_REQUESTED",
    userId: educatorId,
    pagePath: "/instructor/settings/payout",
    metadata: {
      payoutRequestId: request.id,
      amount: request.amount,
      currency: request.currency,
      payoutCycle: cycleWindow.payoutCycle,
    },
  });

  try {
    return await executePayout(request.id);
  } catch (error) {
    const latestRequest = await prisma.payoutRequest.findUnique({
      where: { id: request.id },
      include: payoutRequestItemsInclude,
    });
    if (latestRequest) {
      return latestRequest;
    }
    throw error;
  }
}

export async function runAutoPayoutProcessing(triggeredBy = "system") {
  const verifiedPayoutAccounts = await prisma.payoutAccount.findMany({
    where: {
      isVerified: true,
    },
    select: {
      userId: true,
    },
  });

  let created = 0;
  let skipped = 0;
  let failed = 0;
  const failures = [];

  for (const account of verifiedPayoutAccounts) {
    try {
      await requestPayout(account.userId, {
        note: `Auto payout (${triggeredBy})`,
      });
      created += 1;
    } catch (error) {
      if (isSkippableAutoPayoutError(error)) {
        skipped += 1;
      } else {
        failed += 1;
        failures.push({
          educatorId: account.userId,
          message: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
  }

  return {
    triggeredBy,
    minimumPayoutAmount: MIN_PAYOUT_AMOUNT_PHP,
    processedEducators: verifiedPayoutAccounts.length,
    createdRequests: created,
    skippedEducators: skipped,
    failedEducators: failed,
    failures,
    processedAt: new Date(),
  };
}

export async function listMyPayouts(educatorId, query) {
  const { page, limit, skip } = getPagination(query);
  const where = { educatorId };
  const [rows, total] = await Promise.all([
    prisma.payoutRequest.findMany({
      where,
      skip,
      take: limit,
      include: payoutRequestItemsInclude,
      orderBy: { createdAt: "desc" },
    }),
    prisma.payoutRequest.count({ where }),
  ]);
  const refreshedRows = await mapWithConcurrency(rows, refreshExecutedPayoutStatus);
  return toPagedResult(refreshedRows, total, page, limit);
}

export async function listAllPayouts(query) {
  const { page, limit, skip } = getPagination(query);
  const where = { status: query.status || undefined };
  const [rows, total] = await Promise.all([
    prisma.payoutRequest.findMany({
      where,
      skip,
      take: limit,
      include: {
        educator: {
          select: { id: true, username: true, email: true },
        },
        ...payoutRequestItemsInclude,
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.payoutRequest.count({ where }),
  ]);
  const refreshedRows = await mapWithConcurrency(rows, refreshExecutedPayoutStatus);
  return toPagedResult(refreshedRows, total, page, limit);
}

export async function approvePayout(adminId, payoutRequestId, reviewNote) {
  const payout = await prisma.payoutRequest.findUnique({
    where: { id: payoutRequestId },
  });
  if (!payout) {
    throw new ApiError(404, "Payout request not found");
  }
  if (payout.status !== "REQUESTED") {
    throw new ApiError(400, "Only requested payouts can be approved");
  }

  const updated = await prisma.payoutRequest.update({
    where: { id: payoutRequestId },
    data: {
      status: "APPROVED",
      reviewedById: adminId,
      reviewedAt: new Date(),
      reviewNote: reviewNote || null,
    },
  });
  await appendPayoutEvent(updated.id, "PAYOUT.APPROVED", {
    approvedById: adminId,
    reviewNote: reviewNote || null,
    autoApproved: false,
  });

  await createNotification({
    userId: updated.educatorId,
    type: "PAYOUT",
    title: "Payout approved",
    message: `Your payout request ${updated.id} has been approved.`,
    metadata: { payoutRequestId: updated.id },
  });

  return executePayout(updated.id);
}

export async function rejectPayout(adminId, payoutRequestId, reviewNote) {
  const payout = await prisma.payoutRequest.findUnique({
    where: { id: payoutRequestId },
  });
  if (!payout) {
    throw new ApiError(404, "Payout request not found");
  }
  if (payout.status !== "REQUESTED") {
    throw new ApiError(400, "Only requested payouts can be rejected");
  }

  const updated = await prisma.payoutRequest.update({
    where: { id: payoutRequestId },
    data: {
      status: "REJECTED",
      reviewedById: adminId,
      reviewedAt: new Date(),
      reviewNote: reviewNote || null,
    },
  });
  await prisma.educatorEarning.updateMany({
    where: { payoutRequestId: updated.id },
    data: { payoutRequestId: null, status: "AVAILABLE" },
  });
  await appendPayoutEvent(updated.id, "PAYOUT.REJECTED", {
    rejectedById: adminId,
    reviewNote: reviewNote || null,
  });

  await createNotification({
    userId: updated.educatorId,
    type: "PAYOUT",
    title: "Payout rejected",
    message: `Your payout request ${updated.id} was rejected.`,
    metadata: { payoutRequestId: updated.id },
  });

  return updated;
}

export async function retryMyFailedPayout(educatorId, payoutRequestId) {
  const payout = await prisma.payoutRequest.findFirst({
    where: { id: payoutRequestId, educatorId },
    select: { id: true, status: true },
  });
  if (!payout) {
    throw new ApiError(404, "Payout request not found");
  }
  if (payout.status !== "FAILED") {
    throw new ApiError(400, "Only failed payouts can be retried");
  }

  // Atomically claim the retry so double-clicks cannot send two payouts.
  const claimed = await prisma.payoutRequest.updateMany({
    where: { id: payout.id, status: "FAILED" },
    data: { status: "APPROVED", reviewNote: "Retry requested by instructor" },
  });
  if (claimed.count === 0) {
    throw new ApiError(409, "This payout is already being retried");
  }
  await appendPayoutEvent(payout.id, "PAYOUT.RETRIED", {
    retriedById: educatorId,
  });

  return executePayout(payout.id, {
    retryToken: Date.now().toString(36),
  });
}

export async function returnMyFailedPayout(educatorId, payoutRequestId) {
  const payout = await prisma.payoutRequest.findFirst({
    where: { id: payoutRequestId, educatorId },
    select: { id: true, status: true },
  });
  if (!payout) {
    throw new ApiError(404, "Payout request not found");
  }
  if (payout.status !== "FAILED") {
    throw new ApiError(400, "Only failed payouts can be returned to balance");
  }

  const updated = await prisma.$transaction(async (tx) => {
    const claimed = await tx.payoutRequest.updateMany({
      where: { id: payout.id, status: "FAILED" },
      data: {
        status: "REJECTED",
        reviewNote: "Returned to available balance by instructor",
        reviewedAt: new Date(),
      },
    });
    if (claimed.count === 0) {
      throw new ApiError(409, "This payout can no longer be returned");
    }
    // Releasing the items makes the earnings available for a new payout.
    await tx.payoutRequestItem.deleteMany({
      where: { payoutRequestId: payout.id },
    });
    await tx.educatorEarning.updateMany({
      where: { payoutRequestId: payout.id },
      data: { payoutRequestId: null, status: "AVAILABLE" },
    });
    await tx.payoutRequestEvent.create({
      data: {
        payoutRequestId: payout.id,
        eventType: "PAYOUT.RETURNED",
        occurredAt: new Date(),
        payload: { returnedById: educatorId },
      },
    });
    return tx.payoutRequest.findUnique({
      where: { id: payout.id },
      include: payoutRequestItemsInclude,
    });
  });

  await createNotification({
    userId: educatorId,
    type: "PAYOUT",
    title: "Payout returned to balance",
    message: `The amount for failed payout ${payout.id} is available again.`,
    metadata: { payoutRequestId: payout.id },
  });

  return updated;
}

export async function executePayout(payoutRequestId, options = {}) {
  const payout = await prisma.payoutRequest.findUnique({
    where: { id: payoutRequestId },
    include: {
      educator: {
        select: {
          id: true,
          payoutAccount: {
            select: {
              channelCode: true,
              accountNumber: true,
              accountHolderName: true,
              isVerified: true,
            },
          },
        },
      },
    },
  });
  if (!payout) {
    throw new ApiError(404, "Payout request not found");
  }
  if (!["APPROVED", "FAILED"].includes(String(payout.status))) {
    throw new ApiError(400, "Only approved or failed payouts can be executed");
  }
  const account = payout.educator?.payoutAccount;
  if (!account?.isVerified || !account?.accountNumber || !account?.channelCode) {
    throw new ApiError(
      400,
      "Educator payout account is not connected or verified",
    );
  }

  const retryToken = options.retryToken || "";
  const referenceId = retryToken ? `${payout.id}:${retryToken}` : payout.id;

  let payoutResult;
  try {
    payoutResult = await createXenditPayout({
      referenceId,
      idempotencyKey: referenceId,
      channelCode: account.channelCode,
      accountNumber: account.accountNumber,
      accountHolderName: account.accountHolderName,
      amount: payout.amount,
      currency: env.xenditPayoutCurrency,
      description: payout.note || undefined,
    });
  } catch (error) {
    const providerMessage = getXenditErrorMessage(error);
    const failed = await prisma.payoutRequest.update({
      where: { id: payoutRequestId },
      data: {
        status: "FAILED",
        reviewNote: providerMessage.slice(0, 500),
      },
    });
    await appendPayoutEvent(failed.id, "PAYMENT.PAYOUTS-ITEM.FAILED", {
      providerMessage: providerMessage.slice(0, 500),
      stage: "create-payout",
    });
    throw new ApiError(502, `Xendit payout failed: ${providerMessage}`);
  }

  const providerPayoutId = payoutResult?.id || null;
  const mutation = mapXenditPayoutStatusToMutation(
    payoutResult?.status,
    payoutResult?.failure_code,
  );

  if (!providerPayoutId || !mutation || mutation.status === "FAILED") {
    const providerMessage =
      mutation?.reviewNote ||
      `Xendit payout was not accepted (${payoutResult?.status || "UNKNOWN"})`;
    const failed = await prisma.payoutRequest.update({
      where: { id: payoutRequestId },
      data: {
        status: "FAILED",
        reviewNote: String(providerMessage).slice(0, 500),
      },
    });
    await appendPayoutEvent(failed.id, "PAYMENT.PAYOUTS-ITEM.FAILED", {
      xenditStatus: payoutResult?.status || "UNKNOWN",
      providerMessage: String(providerMessage).slice(0, 500),
      stage: "payout-accepted-check",
      xenditPayoutId: providerPayoutId,
    });
    throw new ApiError(502, `Xendit payout failed: ${providerMessage}`);
  }

  const updated = await prisma.payoutRequest.update({
    where: { id: payoutRequestId },
    data: {
      status: "EXECUTED",
      currency: env.xenditPayoutCurrency,
      executedAt: new Date(),
      xenditPayoutId: providerPayoutId,
      reviewNote: mutation.reviewNote ?? payout.reviewNote,
    },
  });
  await prisma.educatorEarning.updateMany({
    where: { payoutRequestId: updated.id },
    data: { status: "PAID" },
  });
  await appendPayoutEvent(updated.id, mutation.eventType, {
    xenditStatus: mutation.webhookStatus,
    xenditPayoutId: providerPayoutId,
    stage: "execute-payout",
  });

  await createNotification({
    userId: updated.educatorId,
    type: "PAYOUT",
    title: "Payout executed",
    message: `Your payout request ${updated.id} has been submitted to Xendit.`,
    metadata: { payoutRequestId: updated.id, xenditPayoutId: providerPayoutId },
  });

  return updated;
}
