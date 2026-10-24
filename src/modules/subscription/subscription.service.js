import { prisma } from "../../shared/database/prisma.js";
import { env } from "../../shared/config/env.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { createNotification } from "../notification/notification.service.js";
import { getPlatformCommerceSettings } from "../platform-settings/platform-settings.service.js";
import {
  cancelPayPalSubscription,
  getPayPalSubscription,
  verifyPayPalWebhookEvent,
} from "../checkout/paypal.service.js";
import {
  createXenditRecurringPlan,
  createXenditSubscriptionSession,
  deactivateXenditRecurringPlan,
  getXenditSession,
  isXenditConfigured,
} from "../checkout/xendit.service.js";
import { syncSubscriptionEnrollments } from "../access/access.service.js";

const round2 = (value) => Number(Number(value || 0).toFixed(2));

function addInterval(date, interval) {
  const next = new Date(date);
  if (interval === "YEAR") next.setUTCFullYear(next.getUTCFullYear() + 1);
  else next.setUTCMonth(next.getUTCMonth() + 1);
  return next;
}

export async function listPublicPlans() {
  const plans = await prisma.plan.findMany({
    where: { isActive: true },
    orderBy: [{ interval: "asc" }, { price: "asc" }],
  });
  return plans.map((plan) => ({
    id: plan.id,
    name: plan.name,
    interval: plan.interval,
    price: Number(plan.price),
    firstCyclePrice: plan.firstCyclePrice == null ? null : Number(plan.firstCyclePrice),
    currency: plan.currency,
    available: isXenditConfigured(),
  }));
}

export async function getCatalogSummary() {
  const courseCount = await prisma.course.count({
    where: {
      deletedAt: null,
      subscriptionEligible: true,
      OR: [{ workflowStatus: "PUBLISHED" }, { isPublished: true }],
    },
  });
  return { courseCount };
}

export async function listAllPlans() {
  const plans = await prisma.plan.findMany({
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { subscriptions: true } } },
  });
  return plans.map((plan) => ({
    ...plan,
    price: Number(plan.price),
    firstCyclePrice: plan.firstCyclePrice == null ? null : Number(plan.firstCyclePrice),
  }));
}

export async function createPlan(payload) {
  const settings = await getPlatformCommerceSettings();
  const currency = payload.currency || settings.defaultCurrency;
  return prisma.plan.create({
    data: {
      name: payload.name,
      interval: payload.interval,
      price: payload.price,
      firstCyclePrice: payload.firstCyclePrice ?? null,
      currency,
      isActive: payload.isActive ?? true,
    },
  });
}

// Prices are immutable once subscribers exist; only the name and visibility can change.
export async function updatePlan(planId, payload) {
  const plan = await prisma.plan.findUnique({ where: { id: planId } });
  if (!plan) throw new ApiError(404, "Plan not found");
  return prisma.plan.update({
    where: { id: planId },
    data: {
      name: payload.name ?? undefined,
      isActive: payload.isActive ?? undefined,
    },
  });
}

// Only same-site relative paths are allowed as the post-checkout destination.
function safeNextPath(next) {
  const value = String(next || "");
  return value.startsWith("/") && !value.startsWith("//") && !value.includes("\\") ? value : "";
}

export async function subscribeToPlan(userId, planId, next) {
  const [plan, user, active] = await Promise.all([
    prisma.plan.findFirst({ where: { id: planId, isActive: true } }),
    prisma.user.findUnique({ where: { id: userId }, select: { email: true, username: true } }),
    prisma.subscription.findFirst({
      where: {
        userId,
        OR: [
          { status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] } },
          { status: "CANCELED", currentPeriodEnd: { gt: new Date() } },
        ],
      },
    }),
  ]);
  if (!plan) throw new ApiError(404, "Plan not found");
  if (active) throw new ApiError(409, "You already have an active subscription");
  if (!isXenditConfigured()) {
    throw new ApiError(503, "Card payments are not available yet");
  }

  const returnPath = safeNextPath(next) || "/my-courses/learning";
  const joiner = returnPath.includes("?") ? "&" : "?";
  // The learner pays the introductory price (if any) now; renewals use the regular price.
  const firstAmount = plan.firstCyclePrice != null ? plan.firstCyclePrice : plan.price;

  const subscription = await prisma.subscription.create({
    data: { userId, planId, status: "PENDING", provider: "XENDIT" },
  });
  try {
    const session = await createXenditSubscriptionSession({
      referenceId: subscription.id,
      customer: {
        referenceId: `upskill-${userId}-${subscription.id}`,
        email: user?.email,
        name: user?.username,
      },
      amount: Number(firstAmount),
      currency: plan.currency,
      description: `Upskill ${plan.name} subscription`,
      successUrl: `${env.frontendUrl}${returnPath}${joiner}status=success&subscription_id=${subscription.id}`,
      cancelUrl: `${env.frontendUrl}${returnPath}${joiner}status=canceled`,
    });
    if (!session?.payment_session_id || !session?.payment_link_url) {
      throw new ApiError(502, "Xendit did not return a payment link");
    }
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: {
        xenditSessionId: session.payment_session_id,
        xenditCustomerId: session.customer_id || null,
      },
    });
    return { subscriptionId: subscription.id, approveUrl: session.payment_link_url };
  } catch (error) {
    await prisma.subscription.delete({ where: { id: subscription.id } }).catch(() => null);
    throw error;
  }
}

async function activateSubscription(subscription, remote) {
  const now = new Date();
  const periodEnd = remote?.billing_info?.next_billing_time
    ? new Date(remote.billing_info.next_billing_time)
    : addInterval(now, subscription.plan.interval);
  const periodStart = remote?.billing_info?.last_payment?.time
    ? new Date(remote.billing_info.last_payment.time)
    : now;
  return applySubscriptionPeriod(subscription, periodStart, periodEnd);
}

async function applySubscriptionPeriod(subscription, periodStart, periodEnd) {
  const updated = await prisma.subscription.update({
    where: { id: subscription.id },
    data: {
      status: "ACTIVE",
      currentPeriodStart: periodStart,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
      canceledAt: null,
    },
  });
  await prisma.entitlement.create({
    data: { userId: subscription.userId, source: "SUBSCRIPTION", startsAt: periodStart, endsAt: periodEnd },
  });
  // Trial and subscription never overlap: subscription replaces any remaining trial window.
  await syncSubscriptionEnrollments(subscription.userId, periodEnd);
  return updated;
}

export async function confirmSubscription(userId, subscriptionId) {
  const subscription = await prisma.subscription.findFirst({
    where: {
      userId,
      OR: [{ id: String(subscriptionId) }, { paypalSubscriptionId: String(subscriptionId) }],
    },
    include: { plan: true },
  });
  if (!subscription) throw new ApiError(404, "Subscription not found");
  if (subscription.status === "ACTIVE") return subscription;

  if (subscription.provider === "XENDIT") {
    // The webhook normally activates it; this covers the learner returning before it lands.
    const session = await getXenditSession(subscription.xenditSessionId);
    if (session?.payment_token_id) {
      await activateXenditSubscription(subscription, session.payment_token_id);
    }
    const fresh = await prisma.subscription.findUnique({ where: { id: subscription.id } });
    if (fresh?.status !== "ACTIVE") {
      throw new ApiError(409, "Your payment is still being confirmed. Please wait a moment.");
    }
    return fresh;
  }

  const remote = await getPayPalSubscription(subscription.paypalSubscriptionId);
  if (remote.status !== "ACTIVE") {
    throw new ApiError(409, `Subscription is not active yet (status: ${remote.status})`);
  }
  const updated = await activateSubscription(subscription, remote);
  await createNotification({
    userId,
    type: "SYSTEM",
    title: "Subscription active",
    message: `Your ${subscription.plan.name} plan is now active.`,
  }).catch(() => null);
  return updated;
}

export async function cancelMySubscription(userId) {
  const subscription = await prisma.subscription.findFirst({
    where: { userId, status: { in: ["ACTIVE", "TRIALING", "PAST_DUE"] } },
    orderBy: { createdAt: "desc" },
  });
  if (!subscription) throw new ApiError(404, "No active subscription found");

  if (subscription.provider === "XENDIT") {
    if (subscription.xenditPlanId) {
      await deactivateXenditRecurringPlan(subscription.xenditPlanId);
    }
  } else if (subscription.paypalSubscriptionId) {
    await cancelPayPalSubscription(subscription.paypalSubscriptionId);
  }
  return prisma.subscription.update({
    where: { id: subscription.id },
    data: { status: "CANCELED", cancelAtPeriodEnd: true, canceledAt: new Date() },
  });
}

async function recordInvoice(subscription, resource) {
  const externalId = String(resource?.id || "");
  if (!externalId) return;
  const existing = await prisma.subscriptionInvoice.findUnique({ where: { externalId } });
  if (existing) return;

  const settings = await getPlatformCommerceSettings();
  const amount = round2(resource?.amount?.total || resource?.amount?.value || subscription.plan.price);
  const processorFee = round2(resource?.transaction_fee?.value || 0);
  // Prices are tax-inclusive; the tax share and processor fee are removed before the educator pool.
  const taxAmount = round2(amount - amount / (1 + settings.taxPercent / 100));
  const netAmount = round2(Math.max(0, amount - taxAmount - processorFee));

  await prisma.subscriptionInvoice.create({
    data: {
      subscriptionId: subscription.id,
      externalId,
      amount,
      taxAmount,
      netAmount,
      currency: resource?.amount?.currency || subscription.plan.currency,
      status: "PAID",
      paidAt: resource?.create_time ? new Date(resource.create_time) : new Date(),
    },
  });
}

export async function handleSubscriptionWebhook(event, headers = {}) {
  await verifyPayPalWebhookEvent(headers, event, env.paypalSubscriptionWebhookId);

  const type = String(event?.event_type || "");
  const resource = event?.resource || {};
  const paypalId =
    type.startsWith("PAYMENT.SALE") ? resource.billing_agreement_id : resource.id;
  if (!paypalId) return { accepted: true, ignored: true };

  const subscription = await prisma.subscription.findUnique({
    where: { paypalSubscriptionId: String(paypalId) },
    include: { plan: true },
  });
  if (!subscription) return { accepted: true, ignored: true };

  if (type === "BILLING.SUBSCRIPTION.ACTIVATED") {
    if (subscription.status !== "ACTIVE") {
      const remote = await getPayPalSubscription(paypalId).catch(() => null);
      await activateSubscription(subscription, remote);
    }
  } else if (type === "PAYMENT.SALE.COMPLETED") {
    await recordInvoice(subscription, resource);
    const remote = await getPayPalSubscription(paypalId).catch(() => null);
    await activateSubscription(subscription, remote);
  } else if (type === "PAYMENT.SALE.REFUNDED" || type === "PAYMENT.SALE.REVERSED") {
    await prisma.subscriptionInvoice.updateMany({
      where: { externalId: String(resource.sale_id || resource.parent_payment || "") },
      data: { status: "REFUNDED" },
    });
  } else if (type === "BILLING.SUBSCRIPTION.CANCELLED") {
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: { status: "CANCELED", cancelAtPeriodEnd: true, canceledAt: new Date() },
    });
  } else if (type === "BILLING.SUBSCRIPTION.EXPIRED") {
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: { status: "EXPIRED" },
    });
  } else if (
    type === "BILLING.SUBSCRIPTION.SUSPENDED" ||
    type === "BILLING.SUBSCRIPTION.PAYMENT.FAILED"
  ) {
    await prisma.subscription.update({
      where: { id: subscription.id },
      data: { status: "PAST_DUE" },
    });
    await createNotification({
      userId: subscription.userId,
      type: "SYSTEM",
      title: "Subscription payment failed",
      message: "We could not renew your plan. Update your PayPal payment method to keep access.",
    }).catch(() => null);
  } else {
    return { accepted: true, ignored: true };
  }

  return { accepted: true };
}

async function activateXenditSubscription(subscription, tokenId) {
  if (subscription.status === "ACTIVE" || subscription.xenditPlanId) return;
  const now = new Date();
  const periodEnd = addInterval(now, subscription.plan.interval);

  // The first period is already paid through the session; the first scheduled charge is one period later.
  const plan = await createXenditRecurringPlan({
    referenceId: `sub-${subscription.id}`,
    customerId: subscription.xenditCustomerId,
    tokenId,
    amount: Number(subscription.plan.price),
    currency: subscription.plan.currency,
    interval: subscription.plan.interval,
    anchorDate: periodEnd,
    description: `Upskill ${subscription.plan.name} subscription`,
  });

  await prisma.subscription.update({
    where: { id: subscription.id },
    data: { xenditPlanId: plan.id, xenditTokenId: tokenId },
  });
  await applySubscriptionPeriod(subscription, now, periodEnd);
  await createNotification({
    userId: subscription.userId,
    type: "SYSTEM",
    title: "Subscription active",
    message: `Your ${subscription.plan.name} plan is now active.`,
  }).catch(() => null);
}

async function recordXenditInvoice(subscription, { externalId, amount, paidAt }) {
  if (!externalId) return;
  const existing = await prisma.subscriptionInvoice.findUnique({ where: { externalId } });
  if (existing) return;

  const settings = await getPlatformCommerceSettings();
  const gross = round2(amount || subscription.plan.price);
  // Prices are tax-inclusive. The processor fee is not reported on the webhook, so net excludes tax only.
  const taxAmount = round2(gross - gross / (1 + settings.taxPercent / 100));
  await prisma.subscriptionInvoice.create({
    data: {
      subscriptionId: subscription.id,
      externalId,
      amount: gross,
      taxAmount,
      netAmount: round2(Math.max(0, gross - taxAmount)),
      currency: subscription.plan.currency,
      status: "PAID",
      paidAt: paidAt ? new Date(paidAt) : new Date(),
    },
  });
}

export async function handleXenditSubscriptionWebhook(event) {
  const type = String(event?.event || "");
  const data = event?.data || {};
  const include = { plan: true };

  if (type === "payment_token.activation") {
    const subscription = await prisma.subscription.findFirst({
      where: { provider: "XENDIT", xenditCustomerId: data.customer_id, status: "PENDING" },
      orderBy: { createdAt: "desc" },
      include,
    });
    if (!subscription) return { accepted: true, ignored: true };
    await activateXenditSubscription(subscription, data.payment_token_id);
  } else if (type === "payment.capture") {
    const subscription = await prisma.subscription.findFirst({
      where: { provider: "XENDIT", xenditCustomerId: data.customer_id },
      orderBy: { createdAt: "desc" },
      include,
    });
    if (!subscription) return { accepted: true, ignored: true };
    await recordXenditInvoice(subscription, {
      externalId: data.payment_id,
      amount: data.request_amount,
      paidAt: data.created,
    });
  } else if (type === "recurring.cycle.succeeded") {
    const subscription = await prisma.subscription.findUnique({
      where: { xenditPlanId: String(data.plan_id || "") },
      include,
    });
    if (!subscription) return { accepted: true, ignored: true };
    const attempt = (data.attempt_details || []).find((item) => item.payment_id);
    await recordXenditInvoice(subscription, {
      externalId: attempt?.payment_id || data.id,
      amount: data.amount,
      paidAt: new Date(),
    });
    const base =
      subscription.currentPeriodEnd && subscription.currentPeriodEnd > new Date()
        ? subscription.currentPeriodEnd
        : new Date();
    await applySubscriptionPeriod(subscription, new Date(), addInterval(base, subscription.plan.interval));
  } else if (type === "recurring.cycle.failed") {
    const subscription = await prisma.subscription.findUnique({
      where: { xenditPlanId: String(data.plan_id || "") },
      include,
    });
    if (!subscription) return { accepted: true, ignored: true };
    await prisma.subscription.update({ where: { id: subscription.id }, data: { status: "PAST_DUE" } });
    await createNotification({
      userId: subscription.userId,
      type: "SYSTEM",
      title: "Subscription payment failed",
      message: "We could not renew your plan with your saved card. Subscribe again to keep access.",
    }).catch(() => null);
  } else {
    return { accepted: true, ignored: true };
  }
  return { accepted: true };
}

// Moves subscriptions whose paid period is over to EXPIRED (enrollments are handled by the access scheduler).
export async function expireLapsedSubscriptions() {
  const result = await prisma.subscription.updateMany({
    where: {
      status: { in: ["CANCELED", "PAST_DUE"] },
      currentPeriodEnd: { lte: new Date() },
    },
    data: { status: "EXPIRED" },
  });
  return result.count;
}

export async function listSubscriptionsAdmin({ page = 1, limit = 20 } = {}) {
  const take = Math.min(Number(limit) || 20, 100);
  const skip = (Math.max(Number(page) || 1, 1) - 1) * take;
  const [rows, total, activeCount, mrr] = await Promise.all([
    prisma.subscription.findMany({
      orderBy: { createdAt: "desc" },
      skip,
      take,
      include: {
        plan: { select: { name: true, interval: true, price: true } },
        user: { select: { id: true, username: true, email: true } },
      },
    }),
    prisma.subscription.count(),
    prisma.subscription.count({ where: { status: "ACTIVE" } }),
    prisma.subscriptionInvoice.aggregate({
      where: { status: "PAID", paidAt: { gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) } },
      _sum: { netAmount: true },
    }),
  ]);
  return {
    data: rows,
    total,
    activeCount,
    last30DaysNetRevenue: round2(mrr._sum.netAmount || 0),
  };
}
