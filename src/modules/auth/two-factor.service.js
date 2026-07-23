import crypto from "crypto";
import QRCode from "qrcode";
import speakeasy from "speakeasy";
import { compareToken, hashToken } from "../../shared/utils/security.js";

const BACKUP_CODE_COUNT = 8;
const BACKUP_CODE_LENGTH = 10;
const APP_ISSUER = "Upskill";

function normalizeCode(rawCode) {
  return String(rawCode || "")
    .replace(/\s+/g, "")
    .toUpperCase();
}

function randomBackupCode() {
  return crypto
    .randomBytes(Math.ceil(BACKUP_CODE_LENGTH / 2))
    .toString("hex")
    .slice(0, BACKUP_CODE_LENGTH)
    .toUpperCase();
}

function toHashedArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || "").trim())
    .filter(Boolean);
}

export async function createTwoFactorSetup(email) {
  const secret = speakeasy.generateSecret({
    length: 32,
    name: `${APP_ISSUER} (${String(email || "").trim().toLowerCase()})`,
    issuer: APP_ISSUER,
  });

  const svg = await QRCode.toString(secret.otpauth_url, { type: "svg" });
  const qrCode = Buffer.from(svg).toString("base64");

  return {
    base32Secret: secret.base32,
    qrCode,
  };
}

export function verifyTotpToken(secret, code) {
  const normalizedCode = normalizeCode(code);
  if (!/^\d{6}$/.test(normalizedCode)) return false;

  return speakeasy.totp.verify({
    secret,
    encoding: "base32",
    token: normalizedCode,
    window: 1,
  });
}

export async function generateBackupCodes() {
  const rawCodes = Array.from({ length: BACKUP_CODE_COUNT }, () =>
    randomBackupCode(),
  );
  const hashedCodes = await Promise.all(rawCodes.map((code) => hashToken(code)));
  return {
    rawCodes,
    hashedCodes,
  };
}

export async function consumeBackupCode(code, hashes) {
  const normalizedCode = normalizeCode(code);
  const currentHashes = toHashedArray(hashes);

  for (let i = 0; i < currentHashes.length; i += 1) {
    const isValid = await compareToken(normalizedCode, currentHashes[i]);
    if (isValid) {
      const nextHashes = [...currentHashes];
      nextHashes.splice(i, 1);
      return {
        consumed: true,
        nextHashes,
      };
    }
  }

  return {
    consumed: false,
    nextHashes: currentHashes,
  };
}

export function countBackupCodes(hashes) {
  return toHashedArray(hashes).length;
}
