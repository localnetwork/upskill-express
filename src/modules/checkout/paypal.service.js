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

export async function createPayPalOrder({ amount, currency, referenceId }) {
  return paypalRequest("POST", "/v2/checkout/orders", {
    intent: "CAPTURE",
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
