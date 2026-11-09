import { env } from "../config/env.js";

const BRAND = "#0052CC";
const INK = "#16161D";
const MUTED = "#5B6475";
const LINE = "#E6EAF2";
const PAGE_BG = "#EEF2F9";
const FONT =
  "'Inter','Segoe UI',-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif";

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

function layout({ preheader, eyebrow, title, bodyHtml, footerNote }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <title>${escapeHtml(title)}</title>
</head>
<body style="margin:0;padding:0;background:${PAGE_BG};font-family:${FONT};color:${INK};-webkit-font-smoothing:antialiased;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(preheader)}&#8203;&zwnj;&#8203;&zwnj;&#8203;&zwnj;</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAGE_BG};">
    <tr><td align="center" style="padding:40px 16px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
        <tr><td align="center" style="padding:0 0 24px;">
          <img src="cid:upskill-logo" alt="${escapeHtml(env.emailFromName)}" width="150" style="display:block;height:auto;border:0;">
        </td></tr>
        <tr><td style="background:#ffffff;border-radius:16px;border:1px solid ${LINE};overflow:hidden;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
            <tr><td style="height:4px;background:${BRAND};font-size:0;line-height:0;">&nbsp;</td></tr>
            <tr><td style="padding:36px 36px 40px;">
              <p style="margin:0 0 10px;font-size:12px;font-weight:700;letter-spacing:1.4px;text-transform:uppercase;color:${BRAND};">${escapeHtml(eyebrow)}</p>
              <h1 style="margin:0 0 18px;font-size:26px;line-height:1.25;font-weight:800;color:${INK};">${escapeHtml(title)}</h1>
              ${bodyHtml}
            </td></tr>
          </table>
        </td></tr>
        <tr><td align="center" style="padding:24px 24px 0;font-size:12px;line-height:1.6;color:${MUTED};">
          ${footerNote ? `<p style="margin:0 0 8px;">${footerNote}</p>` : ""}
          <p style="margin:0;">&copy; ${new Date().getFullYear()} ${escapeHtml(env.emailFromName)}. All rights reserved.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

const paragraph = (html) =>
  `<p style="margin:0 0 16px;font-size:16px;line-height:1.65;color:${INK};">${html}</p>`;

const button = (href, label) =>
  `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:28px 0 24px;">
    <tr><td style="background:${BRAND};border-radius:10px;">
      <a href="${escapeHtml(href)}" style="display:inline-block;padding:14px 30px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">${escapeHtml(label)}</a>
    </td></tr>
  </table>`;

const callout = (html) =>
  `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 8px;">
    <tr><td style="background:#F6F8FC;border-left:3px solid ${BRAND};border-radius:6px;padding:14px 16px;font-size:13px;line-height:1.6;color:${MUTED};">${html}</td></tr>
  </table>`;

const linkFallback = (href) =>
  `<p style="margin:16px 0 0;font-size:12px;line-height:1.6;color:${MUTED};word-break:break-all;">Button not working? Paste this link into your browser:<br><a href="${escapeHtml(href)}" style="color:${BRAND};text-decoration:underline;">${escapeHtml(href)}</a></p>`;

const greetingName = (fullName) =>
  String(fullName || "").trim().split(/\s+/)[0] || "there";

const OTP_PURPOSE_COPY = {
  REGISTER: {
    subject: "Your Upskill sign-up code",
    eyebrow: "Welcome aboard",
    title: "Confirm your email",
    intro: "Use this code to finish creating your account.",
  },
  LOGIN: {
    subject: "Your Upskill login code",
    eyebrow: "Account security",
    title: "Your login code",
    intro: "Use this code to sign in to your account.",
  },
  CHANGE_EMAIL: {
    subject: "Confirm your email change",
    eyebrow: "Account security",
    title: "Confirm your email change",
    intro: "Use this code to confirm you want to change the email on your account.",
  },
};

export function buildOtpEmail({ fullName, code, purpose, expiresInMinutes = 10 }) {
  const copy = OTP_PURPOSE_COPY[purpose] || OTP_PURPOSE_COPY.LOGIN;
  const name = greetingName(fullName);
  return {
    subject: copy.subject,
    text: `Hi ${name},\n\n${copy.intro}\n\nYour code: ${code}\n\nIt expires in ${expiresInMinutes} minutes. If you didn't request this, you can ignore this email.`,
    html: layout({
      preheader: `Your code is ${code}. It expires in ${expiresInMinutes} minutes.`,
      eyebrow: copy.eyebrow,
      title: copy.title,
      bodyHtml: `${paragraph(`Hi ${escapeHtml(name)}, ${escapeHtml(copy.intro.charAt(0).toLowerCase() + copy.intro.slice(1))}`)}
        <p style="margin:24px 0;text-align:center;font-family:Consolas,Menlo,monospace;font-size:36px;font-weight:800;letter-spacing:10px;color:${INK};">${escapeHtml(code)}</p>
        ${callout(`<strong style="color:${INK};">This code expires in ${expiresInMinutes} minutes.</strong> Never share it with anyone. If you didn't request it, you can safely ignore this email.`)}`,
      footerNote: "You're receiving this because a code was requested for this email address.",
    }),
  };
}

export function buildBackupCodesEmail({ fullName, codes, regenerated }) {
  const name = greetingName(fullName);
  const list = codes.map((c) => escapeHtml(c));
  const grid = `<table role="presentation" width="100%" cellpadding="0" cellspacing="8" style="margin:0 0 16px;">${list
    .reduce((rows, c, i) => {
      if (i % 2 === 0) rows.push([]);
      rows[rows.length - 1].push(c);
      return rows;
    }, [])
    .map(
      (row) =>
        `<tr>${row
          .map(
            (c) =>
              `<td style="background:#F6F8FC;border:1px solid ${LINE};border-radius:8px;padding:10px;text-align:center;font-family:Consolas,Menlo,monospace;font-size:15px;letter-spacing:1px;color:${INK};">${c}</td>`,
          )
          .join("")}</tr>`,
    )
    .join("")}</table>`;
  return {
    subject: regenerated
      ? "Your new backup codes"
      : "Your two-factor backup codes",
    text: `Hi ${name},\n\n${regenerated ? "Your backup codes were regenerated; older codes no longer work." : "Two-factor authentication is now enabled."} Keep these single-use backup codes somewhere safe:\n\n${codes.join("\n")}\n\nIf this wasn't you, secure your account immediately.`,
    html: layout({
      preheader: "Store these backup codes somewhere safe.",
      eyebrow: "Account security",
      title: regenerated
        ? "Your new backup codes"
        : "Two-factor authentication enabled",
      bodyHtml: `${paragraph(`Hi ${escapeHtml(name)}, here are your single-use backup codes. Each one can be used once if you lose access to your authenticator app.`)}
        ${grid}
        ${callout(`<strong style="color:${INK};">Keep these private.</strong> Delete this email after saving them somewhere safe. If this wasn't you, secure your account right away.`)}`,
      footerNote:
        "You're receiving this because two-factor settings changed on your account.",
    }),
  };
}

export function buildCoursePublishedEmail({
  fullName,
  courseTitle,
  courseSlug,
  note,
}) {
  const name = greetingName(fullName);
  const link = `${baseUrl()}/courses/${encodeURIComponent(courseSlug)}`;
  return {
    subject: `Your course "${courseTitle}" is live`,
    text: `Hi ${name},\n\nGreat news: "${courseTitle}" has been approved and published. Learners can now find and enroll in it:\n${link}${note ? `\n\nReviewer note: ${note}` : ""}`,
    html: layout({
      preheader: `"${courseTitle}" has been approved and is now live.`,
      eyebrow: "Course published",
      title: "Your course is live",
      bodyHtml: `${paragraph(`Hi ${escapeHtml(name)}, your course <strong>${escapeHtml(courseTitle)}</strong> passed review and has been published. Learners can now find and enroll in it.`)}
        ${note ? callout(`<strong style="color:${INK};">Reviewer note:</strong> ${escapeHtml(note)}`) : ""}
        ${button(link, "View your course")}
        ${linkFallback(link)}`,
      footerNote: "You're receiving this because you submitted a course for review.",
    }),
  };
}

export function buildReceiptEmail({ fullName, order, paidAt }) {
  const currency = order.currency || "PHP";
  const name = greetingName(fullName);
  const receiptNo = String(order.id).slice(-10).toUpperCase();
  const dateLabel = new Date(
    paidAt || order.updatedAt || Date.now(),
  ).toLocaleDateString("en-PH", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const itemRows = (order.items || [])
    .map((item, index, all) => {
      const border =
        index === all.length - 1 ? "" : `border-bottom:1px solid ${LINE};`;
      const educator = item.course?.educator;
      const educatorName = educator?.fullName || "";
      const cover = Array.isArray(item.course?.media)
        ? item.course.media[0]?.storagePath
        : null;
      const coverUrl = /^https:\/\//i.test(String(cover || "")) ? cover : null;
      const thumb = coverUrl
        ? `<img src="${escapeHtml(coverUrl)}" alt="" width="96" height="60" style="display:block;width:96px;height:60px;object-fit:cover;border-radius:8px;border:1px solid ${LINE};">`
        : `<table role="presentation" width="96" height="60" cellpadding="0" cellspacing="0"><tr><td align="center" style="background:#E8F0FD;border-radius:8px;font-size:22px;font-weight:800;color:${BRAND};">${escapeHtml(String(item.course?.title || "C").charAt(0).toUpperCase())}</td></tr></table>`;
      return `<tr>
        <td width="96" valign="top" style="padding:14px 14px 14px 0;${border}">${thumb}</td>
        <td valign="top" style="padding:14px 0;${border}">
          <p style="margin:0;font-size:15px;font-weight:600;line-height:1.4;color:${INK};">${escapeHtml(item.course?.title || "Course")}</p>
          ${educatorName ? `<p style="margin:4px 0 0;font-size:13px;color:${MUTED};">Instructor: <span style="color:${INK};font-weight:600;">${escapeHtml(educatorName)}</span></p>` : ""}
        </td>
        <td align="right" valign="top" style="padding:14px 0 14px 16px;${border}font-size:15px;font-weight:600;color:${INK};white-space:nowrap;">${escapeHtml(formatMoney(item.totalAmount, currency))}</td>
      </tr>`;
    })
    .join("");

  const line = (label, value) =>
    `<tr>
      <td style="padding:5px 0;font-size:14px;color:${MUTED};">${label}</td>
      <td align="right" style="padding:5px 0;font-size:14px;color:${INK};">${escapeHtml(formatMoney(value, currency))}</td>
    </tr>`;

  const metaCell = (label, value) =>
    `<td valign="top" style="padding:0 12px 0 0;">
      <p style="margin:0 0 3px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:${MUTED};">${label}</p>
      <p style="margin:0;font-size:14px;font-weight:600;color:${INK};">${escapeHtml(value)}</p>
    </td>`;

  const discount = Number(order.discountAmount) || 0;
  const tax = Number(order.taxAmount) || 0;

  return {
    subject: `Receipt #${receiptNo} from ${env.emailFromName}`,
    text: `Hi ${name},\n\nThanks for your purchase. Receipt #${receiptNo} (${dateLabel}). Total paid: ${formatMoney(order.totalAmount, currency)}.\nStart learning: ${baseUrl()}/my-courses`,
    html: layout({
      preheader: `Payment of ${formatMoney(order.totalAmount, currency)} received. Your courses are ready.`,
      eyebrow: "Payment receipt",
      title: "Thanks, your courses are ready",
      bodyHtml: `${paragraph(`Hi ${escapeHtml(name)}, your payment went through and you now have full access.`)}
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 4px;background:#F6F8FC;border-radius:10px;">
          <tr><td style="padding:16px 18px;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
              ${metaCell("Receipt", `#${receiptNo}`)}
              ${metaCell("Date", dateLabel)}
              ${metaCell("Amount paid", formatMoney(order.totalAmount, currency))}
            </tr>${
              order.paymentMethod
                ? `<tr><td colspan="3" style="padding-top:14px;">${metaCell("Payment method", order.paymentMethod)}</td></tr>`
                : ""
            }</table>
          </td></tr>
        </table>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;">${itemRows}</table>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-top:12px;border-top:1px solid ${LINE};padding-top:8px;">
          ${line("Subtotal", order.subtotalAmount)}
          ${discount > 0 ? line("Discount", -discount) : ""}
          ${tax > 0 ? line("Tax", tax) : ""}
          <tr>
            <td style="padding:12px 0 0;font-size:16px;font-weight:800;color:${INK};">Total paid</td>
            <td align="right" style="padding:12px 0 0;font-size:20px;font-weight:800;color:${BRAND};">${escapeHtml(formatMoney(order.totalAmount, currency))}</td>
          </tr>
        </table>
        ${button(`${baseUrl()}/my-courses`, "Start learning")}`,
      footerNote: "Keep this email as your proof of purchase.",
    }),
  };
}
