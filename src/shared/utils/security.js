import crypto from "crypto";
import bcrypt from "bcrypt";

export async function hashPassword(value) {
  return bcrypt.hash(value, 10);
}

export async function comparePassword(value, hash) {
  return bcrypt.compare(value, hash);
}

export function randomToken(size = 32) {
  return crypto.randomBytes(size).toString("hex");
}

export async function hashToken(value) {
  return bcrypt.hash(value, 10);
}

export async function compareToken(value, hash) {
  return bcrypt.compare(value, hash);
}
