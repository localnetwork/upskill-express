import { z } from "zod";
import { createdUserValidator } from "../user/user.validator.js";

export const registerValidator = createdUserValidator.extend({
  username: z.string().min(3).max(40),
  role: z.enum(["LEARNER", "EDUCATOR"]).optional(),
});

export const loginValidator = z.object({
  email: z.string().email("Invalid email format"),
  password: z.string().min(1, "Password is required"),
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
