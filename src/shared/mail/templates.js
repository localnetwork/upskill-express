import { env } from "../config/env.js";

const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const formatMoney = (amount, currency = "PHP") => {
  const value = Number(amount || 0);
  try {
    return new Intl.NumberFormat("en-PH", {
      style: "currency",
      currency,
    }).format(value);
  } catch {
    return `${currency} ${value.toFixed(2)}`;
  }
};

const baseUrl = () => env.frontendUrl.replace(/\/$/, "");

function layout(title, bodyHtml) {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f5f7fa;font-family:Arial,Helvetica,sans-serif;color:#16161d;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;">
      <tr><td>
        <img src="cid:upskill-logo" alt="${escapeHtml(env.emailFromName)}" width="140" style="display:block;margin:0 0 24px;height:auto;border:0;" />
        <h1 style="margin:0 0 16px;font-size:22px;">${escapeHtml(title)}</h1>
        ${bodyHtml}
        <p style="margin:32px 0 0;font-size:12px;color:#64748b;">${escapeHtml(env.emailFromName)}</p>
      </td></tr>
    </table>
  </body>
</html>`;
}

const button = (href, label) =>
  `<p style="margin:24px 0;"><a href="${escapeHtml(href)}" style="background:#0056d2;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-weight:bold;display:inline-block;">${escapeHtml(label)}</a></p>
   <p style="font-size:12px;color:#64748b;word-break:break-all;">If the button doesn't work, copy this link:<br>${escapeHtml(href)}</p>`;

export function buildVerificationEmail({ firstName, token }) {
  const link = `${baseUrl()}/verify-email?token=${encodeURIComponent(token)}`;
  return {
    subject: "Verify your email address",
    text: `Hi ${firstName || "there"}, verify your email: ${link}`,
    html: layout(
      "Verify your email",
      `<p>Hi ${escapeHtml(firstName || "there")},</p>
       <p>Thanks for signing up. Please confirm your email address to finish setting up your account.</p>
       ${button(link, "Verify email")}`,
    ),
  };
}

export function buildPasswordResetEmail({ firstName, token }) {
  const link = `${baseUrl()}/reset-password?token=${encodeURIComponent(token)}`;
  return {
    subject: "Reset your password",
    text: `Hi ${firstName || "there"}, reset your password (valid for 30 minutes): ${link}`,
    html: layout(
      "Reset your password",
      `<p>Hi ${escapeHtml(firstName || "there")},</p>
       <p>We received a request to reset your password. This link is valid for 30 minutes.</p>
       ${button(link, "Reset password")}
       <p style="font-size:13px;color:#64748b;">If you didn't request this, you can safely ignore this email.</p>`,
    ),
  };
}

export function buildReceiptEmail({ firstName, order, paidAt }) {
  const currency = order.currency || "PHP";
  const rows = (order.items || [])
    .map(
      (item) => `<tr>
        <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;">${escapeHtml(item.course?.title || "Course")}</td>
        <td style="padding:8px 0;border-bottom:1px solid #e2e8f0;text-align:right;">${escapeHtml(formatMoney(item.totalAmount, currency))}</td>
      </tr>`,
    )
    .join("");

  const summaryRow = (label, value, bold = false) =>
    `<tr><td style="padding:4px 0;${bold ? "font-weight:bold;" : ""}">${label}</td><td style="padding:4px 0;text-align:right;${bold ? "font-weight:bold;" : ""}">${escapeHtml(formatMoney(value, currency))}</td></tr>`;

  const receiptNo = String(order.id).slice(-10).toUpperCase();
  const dateLabel = new Date(
    paidAt || order.updatedAt || Date.now(),
  ).toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" });

  return {
    subject: `Your receipt for order #${receiptNo}`,
    text: `Thanks for your purchase! Order #${receiptNo}, total ${formatMoney(order.totalAmount, currency)}.`,
    html: layout(
      "Payment receipt",
      `<p>Hi ${escapeHtml(firstName || "there")}, thanks for your purchase!</p>
       <p style="font-size:13px;color:#64748b;">Receipt #${escapeHtml(receiptNo)} &middot; ${escapeHtml(dateLabel)}</p>
       <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;">${rows}</table>
       <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:16px;">
         ${summaryRow("Subtotal", order.subtotalAmount)}
         ${Number(order.discountAmount) > 0 ? summaryRow("Discount", -Number(order.discountAmount)) : ""}
         ${Number(order.taxAmount) > 0 ? summaryRow("Tax", order.taxAmount) : ""}
         ${summaryRow("Total paid", order.totalAmount, true)}
       </table>
       ${button(`${baseUrl()}/my-courses`, "Start learning")}`,
    ),
  };
}
