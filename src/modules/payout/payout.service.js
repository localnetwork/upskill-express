import { prisma } from "../../shared/database/prisma.js";
import axios from "axios";
import { ApiError } from "../../shared/utils/ApiError.js";
import { getPagination, toPagedResult } from "../../shared/utils/pagination.js";
import { createNotification } from "../notification/notification.service.js";
import { env } from "../../shared/config/env.js";
import { getPlatformCommerceSettings } from "../platform-settings/platform-settings.service.js";

const MIN_PAYOUT_AMOUNT_PHP = 500;
const PAYOUT_REVIEW_ESTIMATE_DAYS = 3;
const PAYOUT_APPROVED_ESTIMATE_DAYS = 1;

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
  const startOfCurrentDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
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
      message: "Payout was already released to PayPal.",
    };
  }

  if (requestStatus === "APPROVED") {
    const estimatedPayoutAt = addDays(now, PAYOUT_APPROVED_ESTIMATE_DAYS);
    return {
      waitingOn: "PAYPAL_PROCESSING",
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

  if (!hasVerifiedPayoutAccount) {
    const hasMinimumBalance = availableBalance >= minimumPayoutAmount;
    const earliestRequestAt = hasMinimumBalance
      ? now
      : nextPayoutDate || now;
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

let paypalPayoutAccessToken = null;
let paypalPayoutAccessTokenExpiry = 0;

async function getPayPalPayoutAccessToken() {
  if (paypalPayoutAccessToken && Date.now() < paypalPayoutAccessTokenExpiry) {
    return paypalPayoutAccessToken;
  }

  if (!env.paypalClientId || !env.paypalClientSecret) {
    throw new ApiError(500, "PayPal payout credentials are missing");
  }

  const auth = Buffer.from(
    `${env.paypalClientId}:${env.paypalClientSecret}`,
  ).toString("base64");

  const response = await axios.post(
    `${env.paypalBaseUrl}/v1/oauth2/token`,
    "grant_type=client_credentials",
    {
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    },
  );

  paypalPayoutAccessToken = response?.data?.access_token || null;
  paypalPayoutAccessTokenExpiry =
    Date.now() +
    Math.max(Number(response?.data?.expires_in || 0) - 60, 60) * 1000;

  if (!paypalPayoutAccessToken) {
    throw new ApiError(500, "Failed to obtain PayPal payout access token");
  }

  return paypalPayoutAccessToken;
}

function getPayPalErrorMessage(error) {
  const details = error?.response?.data;
  if (details?.message) {
    return String(details.message);
  }
  if (details?.name && details?.details?.[0]?.issue) {
    return `${details.name}: ${details.details[0].issue}`;
  }
  return error instanceof Error ? error.message : "Unknown PayPal error";
}

async function createPayPalPayoutBatch({
  payoutRequestId,
  amount,
  currency,
  receiverEmail,
  note,
}) {
  const accessToken = await getPayPalPayoutAccessToken();

  const senderBatchId = String(payoutRequestId).slice(0, 30);
  const senderItemId = String(payoutRequestId).slice(0, 127);
  const response = await axios.post(
    `${env.paypalBaseUrl}/v1/payments/payouts`,
    {
      sender_batch_header: {
        sender_batch_id: senderBatchId,
        email_subject: "You have received a payout",
        email_message: "Your instructor payout has been sent.",
      },
      items: [
        {
          recipient_type: "EMAIL",
          amount: {
            value: Number(amount).toFixed(2),
            currency: String(currency || "PHP"),
          },
          receiver: receiverEmail,
          note: note || "Instructor payout",
          sender_item_id: senderItemId,
        },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "PayPal-Request-Id": String(payoutRequestId),
      },
    },
  );

  return response?.data || {};
}

export async function connectPayoutAccount(userId, payload) {
  return prisma.payoutAccount.upsert({
    where: { userId },
    update: {
      paypalEmail: payload.paypalEmail,
      paypalMerchantId: payload.paypalMerchantId || null,
      isVerified: true,
    },
    create: {
      userId,
      paypalEmail: payload.paypalEmail,
      paypalMerchantId: payload.paypalMerchantId || null,
      isVerified: true,
    },
  });
}

async function getAvailableOrderItems(educatorId, eligibilityCutoff) {
  return prisma.orderItem.findMany({
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
      order: true,
    },
    orderBy: { createdAt: "asc" },
  });
}

export async function getMyPayoutSummary(educatorId) {
  const now = new Date();
  const settings = await getPlatformCommerceSettings();
  const cycleWindow = getPayoutCycleWindow(settings.payoutCycle, now);
  const eligibilityCutoff = cycleWindow.eligibilityCutoff;
  const periodStart = cycleWindow.periodStart;

  const [
    payoutAccount,
    eligibleAggregate,
    currentMonthAggregate,
    currentMonthRequest,
    latestPayout,
  ] = await Promise.all([
    prisma.payoutAccount.findUnique({
      where: { userId: educatorId },
    }),
    prisma.orderItem.aggregate({
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
      _sum: {
        educatorEarning: true,
      },
    }),
    prisma.orderItem.aggregate({
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
      _sum: {
        educatorEarning: true,
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

  const availableBalance = Number(
    eligibleAggregate?._sum?.educatorEarning || 0,
  );
  const thisMonthEarnings = Number(
    currentMonthAggregate?._sum?.educatorEarning || 0,
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
    hasVerifiedPayoutAccount,
    availableBalance,
    minimumPayoutAmount: MIN_PAYOUT_AMOUNT_PHP,
    currentMonthRequest,
  });

  let cannotRequestReason = "";
  if (!hasVerifiedPayoutAccount) {
    cannotRequestReason = "Connect and verify a PayPal payout account first.";
  } else if (periodStart && currentMonthRequest) {
    cannotRequestReason = `You already have a payout request for this ${cycleWindow.payoutCycle.toLowerCase()} cycle.`;
  } else if (availableBalance < MIN_PAYOUT_AMOUNT_PHP) {
    cannotRequestReason = `Minimum payout is PHP ${MIN_PAYOUT_AMOUNT_PHP.toFixed(2)}.`;
  }

  return {
    minimumPayoutAmount: MIN_PAYOUT_AMOUNT_PHP,
    currency: settings.defaultCurrency,
    payoutCycle: cycleWindow.payoutCycle,
    availableBalance: Number(availableBalance.toFixed(2)),
    thisMonthEarnings: Number(thisMonthEarnings.toFixed(2)),
    hasVerifiedPayoutAccount,
    canRequestPayout: cannotRequestReason.length === 0,
    cannotRequestReason,
    payoutAccount: payoutAccount
      ? {
          paypalEmail: payoutAccount.paypalEmail,
          paypalMerchantId: payoutAccount.paypalMerchantId,
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
    throw new ApiError(400, "Connect and verify PayPal payout account first");
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

  const items = await getAvailableOrderItems(
    educatorId,
    cycleWindow.eligibilityCutoff,
  );
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
    const nextAmount = running + Number(item.educatorEarning);
    if (desiredAmount && nextAmount > desiredAmount && selected.length > 0) {
      break;
    }
    selected.push(item);
    running = nextAmount;
    if (desiredAmount && running >= desiredAmount) {
      break;
    }
  }

  const payoutAmount = Number(running.toFixed(2));
  if (payoutAmount <= 0) {
    throw new ApiError(400, "No eligible earnings for requested amount");
  }
  if (payoutAmount < MIN_PAYOUT_AMOUNT_PHP) {
    throw new ApiError(
      400,
      `Minimum payout is PHP ${MIN_PAYOUT_AMOUNT_PHP.toFixed(2)}`,
    );
  }

  const request = await prisma.$transaction(async (tx) => {
    const payout = await tx.payoutRequest.create({
      data: {
        educatorId,
        amount: payoutAmount,
        currency: settings.defaultCurrency,
        note: payload.note || null,
        calculationSnapshot: {
          orderItemIds: selected.map((item) => item.id),
          gross: selected.reduce(
            (sum, item) => sum + Number(item.unitPrice),
            0,
          ),
          platformFees: selected.reduce(
            (sum, item) => sum + Number(item.platformFeeAmount),
            0,
          ),
          educatorEarnings: payoutAmount,
          minimumPayoutAmount: MIN_PAYOUT_AMOUNT_PHP,
          payoutRule:
            cycleWindow.payoutCycle === "ANYTIME"
              ? "ANYTIME_AVAILABLE_EARNINGS"
              : `${cycleWindow.payoutCycle}_PREVIOUS_PERIOD`,
        },
      },
    });

    for (const item of selected) {
      await tx.payoutRequestItem.create({
        data: {
          payoutRequestId: payout.id,
          orderItemId: item.id,
          amount: item.educatorEarning,
        },
      });
    }

    return payout;
  });

  return request;
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
      include: { items: true },
      orderBy: { createdAt: "desc" },
    }),
    prisma.payoutRequest.count({ where }),
  ]);
  return toPagedResult(rows, total, page, limit);
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
        items: true,
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.payoutRequest.count({ where }),
  ]);
  return toPagedResult(rows, total, page, limit);
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

  await createNotification({
    userId: updated.educatorId,
    type: "PAYOUT",
    title: "Payout rejected",
    message: `Your payout request ${updated.id} was rejected.`,
    metadata: { payoutRequestId: updated.id },
  });

  return updated;
}

export async function executePayout(payoutRequestId) {
  const payout = await prisma.payoutRequest.findUnique({
    where: { id: payoutRequestId },
    include: {
      educator: {
        select: {
          id: true,
          payoutAccount: {
            select: {
              paypalEmail: true,
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
  if (
    !payout.educator?.payoutAccount?.isVerified ||
    !payout.educator?.payoutAccount?.paypalEmail
  ) {
    throw new ApiError(
      400,
      "Educator payout account is not connected or verified",
    );
  }

  let payoutResult;
  try {
    payoutResult = await createPayPalPayoutBatch({
      payoutRequestId: payout.id,
      amount: payout.amount,
      currency: payout.currency,
      receiverEmail: payout.educator.payoutAccount.paypalEmail,
      note: payout.note || undefined,
    });
  } catch (error) {
    const providerMessage = getPayPalErrorMessage(error);
    await prisma.payoutRequest.update({
      where: { id: payoutRequestId },
      data: {
        status: "FAILED",
        reviewNote: providerMessage.slice(0, 500),
      },
    });
    throw new ApiError(502, `PayPal payout failed: ${providerMessage}`);
  }

  const batchHeader = payoutResult?.batch_header || {};
  const providerBatchId = batchHeader?.payout_batch_id || null;
  const batchStatus = String(batchHeader?.batch_status || "").toUpperCase();
  const terminalFailureStatuses = new Set(["DENIED", "CANCELED", "FAILED"]);

  if (!providerBatchId || terminalFailureStatuses.has(batchStatus)) {
    const providerMessage =
      batchHeader?.errors?.name ||
      payoutResult?.name ||
      payoutResult?.message ||
      `PayPal payout batch was not accepted (${batchStatus || "UNKNOWN"})`;
    await prisma.payoutRequest.update({
      where: { id: payoutRequestId },
      data: {
        status: "FAILED",
        reviewNote: String(providerMessage).slice(0, 500),
      },
    });
    throw new ApiError(502, `PayPal payout failed: ${providerMessage}`);
  }

  const updated = await prisma.payoutRequest.update({
    where: { id: payoutRequestId },
    data: {
      status: "EXECUTED",
      executedAt: new Date(),
      paypalBatchId: providerBatchId,
      reviewNote:
        batchStatus && batchStatus !== "SUCCESS"
          ? `PayPal batch status: ${batchStatus}`
          : payout.reviewNote,
    },
  });

  await createNotification({
    userId: updated.educatorId,
    type: "PAYOUT",
    title: "Payout executed",
    message: `Your payout request ${updated.id} has been submitted to PayPal.`,
    metadata: { payoutRequestId: updated.id, paypalBatchId: providerBatchId },
  });

  return updated;
}
