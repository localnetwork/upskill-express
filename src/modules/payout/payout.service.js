import { prisma } from "../../shared/database/prisma.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { getPagination, toPagedResult } from "../../shared/utils/pagination.js";
import { createNotification } from "../notification/notification.service.js";

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

async function getAvailableOrderItems(educatorId) {
  return prisma.orderItem.findMany({
    where: {
      educatorId,
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

export async function requestPayout(educatorId, payload) {
  const payoutAccount = await prisma.payoutAccount.findUnique({
    where: { userId: educatorId },
  });

  if (!payoutAccount || !payoutAccount.isVerified) {
    throw new ApiError(400, "Connect and verify PayPal payout account first");
  }

  const items = await getAvailableOrderItems(educatorId);
  if (items.length === 0) {
    throw new ApiError(400, "No available earnings for payout");
  }

  const desiredAmount = payload.amount || null;
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

  const request = await prisma.$transaction(async (tx) => {
    const payout = await tx.payoutRequest.create({
      data: {
        educatorId,
        amount: payoutAmount,
        note: payload.note || null,
        calculationSnapshot: {
          orderItemIds: selected.map((item) => item.id),
          gross: selected.reduce((sum, item) => sum + Number(item.unitPrice), 0),
          platformFees: selected.reduce(
            (sum, item) => sum + Number(item.platformFeeAmount),
            0,
          ),
          educatorEarnings: payoutAmount,
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

  return updated;
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
  });
  if (!payout) {
    throw new ApiError(404, "Payout request not found");
  }
  if (payout.status !== "APPROVED") {
    throw new ApiError(400, "Only approved payouts can be executed");
  }

  const batchId = `PAYOUT-${Date.now()}`;
  const updated = await prisma.payoutRequest.update({
    where: { id: payoutRequestId },
    data: {
      status: "EXECUTED",
      executedAt: new Date(),
      paypalBatchId: batchId,
    },
  });

  await createNotification({
    userId: updated.educatorId,
    type: "PAYOUT",
    title: "Payout executed",
    message: `Your payout request ${updated.id} has been executed.`,
    metadata: { payoutRequestId: updated.id, paypalBatchId: batchId },
  });

  return updated;
}
