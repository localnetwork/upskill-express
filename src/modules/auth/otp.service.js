import crypto from "crypto";
import { prisma } from "../../shared/database/prisma.js";
import { env } from "../../shared/config/env.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { sendEmail } from "../../shared/mail/mailer.js";
import { buildOtpEmail } from "../../shared/mail/templates.js";

export const OTP_PURPOSE = {
  REGISTER: "REGISTER",
  LOGIN: "LOGIN",
  CHANGE_EMAIL: "CHANGE_EMAIL",
};

const OTP_TTL_MINUTES = 10;
const OTP_RESEND_COOLDOWN_MS = 30 * 1000;
const OTP_MAX_ATTEMPTS = 5;

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function generateCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, "0");
}

function hashCode({ email, purpose, code }) {
  return crypto
    .createHmac("sha256", env.jwtAccessSecret)
    .update(`${purpose}:${normalizeEmail(email)}:${code}`)
    .digest("hex");
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/**
 * Creates a fresh 6-digit code for `email`/`purpose` (invalidating older ones)
 * and emails it to `deliverTo` (defaults to `email`).
 */
export async function issueOtp({
  email,
  purpose,
  userId = null,
  payload = null,
  fullName = "",
  deliverTo,
}) {
  const normalizedEmail = normalizeEmail(email);

  const latest = await prisma.authOtp.findFirst({
    where: { email: normalizedEmail, purpose, consumedAt: null },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (latest && Date.now() - latest.createdAt.getTime() < OTP_RESEND_COOLDOWN_MS) {
    throw new ApiError(
      429,
      "Please wait a few seconds before requesting another code.",
    );
  }

  const code = generateCode();
  await prisma.$transaction([
    prisma.authOtp.deleteMany({
      where: { email: normalizedEmail, purpose, consumedAt: null },
    }),
    prisma.authOtp.create({
      data: {
        email: normalizedEmail,
        purpose,
        userId,
        payload,
        codeHash: hashCode({ email: normalizedEmail, purpose, code }),
        expiresAt: new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000),
      },
    }),
  ]);

  const message = buildOtpEmail({
    fullName,
    code,
    purpose,
    expiresInMinutes: OTP_TTL_MINUTES,
  });
  const sent = await sendEmail({
    to: deliverTo || normalizedEmail,
    ...message,
  });

  if (!sent) {
    if (env.nodeEnv !== "production") {
      console.warn(`[auth] ${purpose} code for ${normalizedEmail}: ${code}`);
    } else {
      throw new ApiError(502, "We couldn't send the verification email. Try again.");
    }
  }

  return { expiresInSeconds: OTP_TTL_MINUTES * 60 };
}

/** Verifies and consumes a code. Returns the stored OTP row (with payload). */
export async function consumeOtp({ email, purpose, code, userId = null }) {
  const normalizedEmail = normalizeEmail(email);
  const normalizedCode = String(code || "").replace(/\s+/g, "");
  const invalid = new ApiError(400, "Invalid or expired code");

  if (!/^\d{6}$/.test(normalizedCode)) throw invalid;

  const record = await prisma.authOtp.findFirst({
    where: {
      email: normalizedEmail,
      purpose,
      consumedAt: null,
      ...(userId ? { userId } : {}),
    },
    orderBy: { createdAt: "desc" },
  });

  if (!record || record.expiresAt < new Date() || record.attempts >= OTP_MAX_ATTEMPTS) {
    throw invalid;
  }

  const matches = safeEqual(
    record.codeHash,
    hashCode({ email: normalizedEmail, purpose, code: normalizedCode }),
  );
  if (!matches) {
    await prisma.authOtp.update({
      where: { id: record.id },
      data: { attempts: { increment: 1 } },
    });
    throw invalid;
  }

  // Atomic claim so a code can only be redeemed once.
  const claimed = await prisma.authOtp.updateMany({
    where: { id: record.id, consumedAt: null },
    data: { consumedAt: new Date() },
  });
  if (claimed.count !== 1) throw invalid;

  return record;
}
