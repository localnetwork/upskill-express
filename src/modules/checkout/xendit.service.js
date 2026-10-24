import axios from "axios";
import crypto from "node:crypto";
import { env } from "../../shared/config/env.js";
import { ApiError } from "../../shared/utils/ApiError.js";

export const XENDIT_PAYMENT_METHODS = {
  GCASH: "GCASH",
  PAYMAYA: "PAYMAYA",
};

function assertConfigured() {
  if (!env.xenditSecretKey) {
    throw new ApiError(500, "Xendit credentials are missing");
  }
}

async function xenditRequest(method, path, data, extraHeaders = {}) {
  assertConfigured();
  try {
    const response = await axios({
      method,
      url: `${env.xenditBaseUrl}${path}`,
      data,
      auth: { username: env.xenditSecretKey, password: "" },
      headers: { "Content-Type": "application/json", ...extraHeaders },
    });
    return response.data;
  } catch (error) {
    // Align with the "invalid provider order" check used by the checkout service.
    if (error?.response?.status === 404 && error.response.data) {
      error.response.data.name = "INVALID_RESOURCE_ID";
    }
    const providerMessage = error?.response?.data?.message;
    if (providerMessage && error?.response?.status !== 404) {
      throw new ApiError(502, `Xendit: ${providerMessage}`);
    }
    throw error;
  }
}

/**
 * Maps a Xendit invoice to the PayPal-like shape used by the checkout service
 * so the existing status/finalize flow can be reused.
 */
export function normalizeXenditInvoice(invoice) {
  const xenditStatus = String(invoice?.status || "").toUpperCase();
  let status = "CREATED";
  if (["PAID", "SETTLED"].includes(xenditStatus)) status = "COMPLETED";
  else if (xenditStatus === "EXPIRED") status = "EXPIRED";
  else if (xenditStatus && xenditStatus !== "PENDING") status = "DECLINED";

  return {
    ...invoice,
    provider: "XENDIT",
    xenditStatus,
    status,
    links: invoice?.invoice_url
      ? [{ rel: "approve", href: invoice.invoice_url, method: "GET" }]
      : [],
    payer: {
      email_address: invoice?.payer_email || null,
      payer_id: null,
    },
    purchase_units: [
      {
        payments: {
          captures:
            status === "COMPLETED"
              ? [{ id: invoice?.payment_id || invoice?.id }]
              : [],
        },
      },
    ],
  };
}

export function resolveXenditPaymentMethod(paymentMethod) {
  const key = String(paymentMethod || "").trim().toUpperCase();
  return XENDIT_PAYMENT_METHODS[key] || null;
}

export async function createXenditInvoice({
  amount,
  currency,
  externalId,
  paymentMethod,
  payerEmail,
  description,
  successRedirectUrl,
  failureRedirectUrl,
}) {
  const method = resolveXenditPaymentMethod(paymentMethod);
  if (!method) {
    throw new ApiError(400, "Unsupported Xendit payment method");
  }

  const invoice = await xenditRequest("POST", "/v2/invoices", {
    external_id: externalId,
    amount: Number(Number(amount).toFixed(2)),
    currency,
    description,
    payer_email: payerEmail || undefined,
    payment_methods: [method],
    invoice_duration: env.xenditInvoiceDurationSeconds,
    success_redirect_url: successRedirectUrl,
    failure_redirect_url: failureRedirectUrl,
  });
  return normalizeXenditInvoice(invoice);
}

export function isXenditConfigured() {
  return Boolean(env.xenditSecretKey);
}

const SUBSCRIPTIONS_API_VERSION = { "api-version": "2026-01-01" };

// Hosted card page that takes the first payment and saves the card for renewals.
export async function createXenditSubscriptionSession({
  referenceId,
  customer,
  amount,
  currency,
  description,
  successUrl,
  cancelUrl,
}) {
  return xenditRequest("POST", "/sessions", {
    reference_id: referenceId,
    customer: {
      reference_id: customer.referenceId,
      type: "INDIVIDUAL",
      email: customer.email || undefined,
      individual_detail: { given_names: customer.name || "Learner" },
    },
    session_type: "PAY",
    allow_save_payment_method: "FORCED",
    mode: "PAYMENT_LINK",
    allowed_payment_channels: ["CARDS"],
    amount: Number(Number(amount).toFixed(2)),
    currency,
    country: "PH",
    locale: "en",
    description,
    success_return_url: successUrl,
    cancel_return_url: cancelUrl,
  });
}

export async function getXenditSession(sessionId) {
  return xenditRequest("GET", `/sessions/${encodeURIComponent(sessionId)}`);
}

export async function createXenditRecurringPlan({
  referenceId,
  customerId,
  tokenId,
  amount,
  currency,
  interval,
  anchorDate,
  description,
}) {
  return xenditRequest(
    "POST",
    "/recurring/plans",
    {
      reference_id: referenceId,
      customer_id: customerId,
      currency,
      amount: Number(Number(amount).toFixed(2)),
      payment_tokens: [{ payment_token_id: tokenId, rank: 1 }],
      schedule: {
        interval,
        interval_count: 1,
        anchor_date: anchorDate.toISOString(),
        retry_interval: "DAY",
        retry_interval_count: 3,
        total_retry: 3,
        failed_attempt_notifications: [1, 3],
      },
      immediate_payment: false,
      failed_cycle_action: "STOP",
      notification_channels: ["EMAIL"],
      locale: "en",
      payment_link_for_failed_attempt: false,
      description,
    },
    SUBSCRIPTIONS_API_VERSION,
  );
}

export async function deactivateXenditRecurringPlan(planId) {
  return xenditRequest(
    "POST",
    `/recurring/plans/${encodeURIComponent(planId)}/deactivate`,
    {},
    SUBSCRIPTIONS_API_VERSION,
  );
}

export async function getXenditInvoice(invoiceId) {
  const invoice = await xenditRequest(
    "GET",
    `/v2/invoices/${encodeURIComponent(invoiceId)}`,
  );
  return normalizeXenditInvoice(invoice);
}

export async function expireXenditInvoice(invoiceId) {
  const invoice = await xenditRequest(
    "POST",
    `/invoices/${encodeURIComponent(invoiceId)}/expire!`,
  );
  return normalizeXenditInvoice(invoice);
}

export function verifyXenditCallbackToken(token) {
  const expected = env.xenditCallbackToken;
  if (!expected || !token) return false;
  const a = Buffer.from(String(token));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
