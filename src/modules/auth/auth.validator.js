import { z } from "zod";
import { createdUserValidator } from "../user/user.validator.js";

export const registerValidator = createdUserValidator.extend({
  username: z.string().min(3).max(40),
  role: z.string().optional(),
});

export const loginValidator = z.object({
  email: z.string().email("Invalid email format").optional(),
  username: z.string().min(3).optional(),
  password: z.string().min(1, "Password is required"),
  trustedDeviceToken: z.string().min(10).max(256).optional(),
  deviceIdentifier: z.string().min(6).max(256).optional(),
  deviceName: z.string().max(120).optional(),
  locationLabel: z.string().max(120).optional(),
});

export const googleAuthValidator = z.object({
  idToken: z.string().min(1, "Google credential is required"),
  intent: z.enum(["login", "register"]),
  mode: z.enum(["student", "instructor"]).optional(),
  trustedDeviceToken: z.string().min(10).max(256).optional(),
  deviceIdentifier: z.string().min(6).max(256).optional(),
  deviceName: z.string().max(120).optional(),
  locationLabel: z.string().max(120).optional(),
});

export const refreshValidator = z.object({
  refreshToken: z.string().min(1),
});

export const forgotPasswordValidator = z.object({
  email: z.string().email(),
});

export const resetPasswordValidator = z.object({
  token: z.string().min(10),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

export const emailVerificationValidator = z.object({
  token: z.string().min(10),
});
