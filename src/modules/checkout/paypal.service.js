import axios from "axios";
import { env } from "../../shared/config/env.js";
import { ApiError } from "../../shared/utils/ApiError.js";

let cachedToken = null;
let cachedTokenExpiry = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiry) {
    return cachedToken;
  }

  if (!env.paypalClientId || !env.paypalClientSecret) {
    throw new ApiError(500, "PayPal credentials are missing");
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

  cachedToken = response.data.access_token;
  cachedTokenExpiry = Date.now() + (response.data.expires_in - 60) * 1000;
  return cachedToken;
}

async function paypalRequest(method, path, data) {
  const token = await getAccessToken();
  const response = await axios({
    method,
    url: `${env.paypalBaseUrl}${path}`,
    data,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
  });
  return response.data;
}

export async function createPayPalOrder({
  amount,
  currency,
  referenceId,
  returnUrl,
  cancelUrl,
}) {
  if (!returnUrl || !cancelUrl) {
    throw new ApiError(500, "PayPal return/cancel URLs are missing");
  }

  return paypalRequest("POST", "/v2/checkout/orders", {
    intent: "CAPTURE",
    application_context: {
      return_url: returnUrl,
      cancel_url: cancelUrl,
      user_action: "PAY_NOW",
      shipping_preference: "NO_SHIPPING",
    },
    purchase_units: [
      {
        reference_id: referenceId,
        amount: {
          currency_code: currency,
          value: Number(amount).toFixed(2),
        },
      },
    ],
  });
}

export async function capturePayPalOrder(providerOrderId) {
  return paypalRequest("POST", `/v2/checkout/orders/${providerOrderId}/capture`, {});
}

export async function getPayPalOrder(providerOrderId) {
  return paypalRequest("GET", `/v2/checkout/orders/${providerOrderId}`);
}

export async function createPayPalBillingPlan({ name, interval, price, currency, firstCyclePrice }) {
  const product = await paypalRequest("POST", "/v1/catalogs/products", {
    name: `Upskill ${name}`,
    type: "SERVICE",
    category: "EDUCATIONAL_AND_TEXTBOOKS",
  });
  const plan = await paypalRequest("POST", "/v1/billing/plans", {
    product_id: product.id,
    name,
    status: "ACTIVE",
    billing_cycles: [
      ...(firstCyclePrice
        ? [
            {
              frequency: { interval_unit: interval, interval_count: 1 },
              tenure_type: "TRIAL",
              sequence: 1,
              total_cycles: 1,
              pricing_scheme: {
                fixed_price: { value: Number(firstCyclePrice).toFixed(2), currency_code: currency },
              },
            },
          ]
        : []),
      {
        frequency: { interval_unit: interval, interval_count: 1 },
        tenure_type: "REGULAR",
        sequence: firstCyclePrice ? 2 : 1,
        total_cycles: 0,
        pricing_scheme: {
          fixed_price: { value: Number(price).toFixed(2), currency_code: currency },
        },
      },
    ],
    payment_preferences: {
      auto_bill_outstanding: true,
      payment_failure_threshold: 2,
    },
  });
  return plan;
}

export async function createPayPalSubscription({ planId, returnUrl, cancelUrl, subscriberEmail }) {
  return paypalRequest("POST", "/v1/billing/subscriptions", {
    plan_id: planId,
    subscriber: subscriberEmail ? { email_address: subscriberEmail } : undefined,
    application_context: {
      brand_name: "Upskill",
      user_action: "SUBSCRIBE_NOW",
      shipping_preference: "NO_SHIPPING",
      return_url: returnUrl,
      cancel_url: cancelUrl,
    },
  });
}

export async function getPayPalSubscription(subscriptionId) {
  return paypalRequest("GET", `/v1/billing/subscriptions/${subscriptionId}`);
}

export async function cancelPayPalSubscription(subscriptionId, reason) {
  return paypalRequest("POST", `/v1/billing/subscriptions/${subscriptionId}/cancel`, {
    reason: String(reason || "Canceled by subscriber").slice(0, 120),
  });
}

export async function verifyPayPalWebhookEvent(headers, webhookEvent, webhookId) {
  if (!webhookId) {
    throw new ApiError(500, "PayPal webhook ID is not configured");
  }
  const data = await paypalRequest("POST", "/v1/notifications/verify-webhook-signature", {
    transmission_id: headers["paypal-transmission-id"],
    transmission_time: headers["paypal-transmission-time"],
    cert_url: headers["paypal-cert-url"],
    auth_algo: headers["paypal-auth-algo"],
    transmission_sig: headers["paypal-transmission-sig"],
    webhook_id: webhookId,
    webhook_event: webhookEvent,
  });
  if (String(data?.verification_status || "").toUpperCase() !== "SUCCESS") {
    throw new ApiError(401, "Invalid PayPal webhook signature");
  }
}
