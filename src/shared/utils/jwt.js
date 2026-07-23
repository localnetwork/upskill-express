import jwt from "jsonwebtoken";
import { env } from "../config/env.js";

export function signAccessToken(payload) {
  return jwt.sign(payload, env.jwtAccessSecret, {
    expiresIn: env.jwtAccessTtl,
  });
}

export function signRefreshToken(payload) {
  return jwt.sign(payload, env.jwtRefreshSecret, {
    expiresIn: env.jwtRefreshTtl,
  });
}

export function signPreAuthToken(payload) {
  return jwt.sign(
    {
      ...payload,
      purpose: "2fa",
    },
    env.jwtAccessSecret,
    {
      expiresIn: env.jwtPreAuthTtl,
    },
  );
}

export function verifyAccessToken(token) {
  return jwt.verify(token, env.jwtAccessSecret);
}

export function verifyRefreshToken(token) {
  return jwt.verify(token, env.jwtRefreshSecret);
}

export function verifyPreAuthToken(token) {
  const payload = jwt.verify(token, env.jwtAccessSecret);
  if (payload?.purpose !== "2fa") {
    throw new Error("Invalid pre-auth token");
  }
  return payload;
}
