import { z } from "zod";

const emailField = z
  .string()
  .trim()
  .toLowerCase()
  .email("Invalid email format");

const codeField = z
  .string()
  .trim()
  .regex(/^\d{6}$/, "Enter the 6-digit code");

const deviceFields = {
  trustedDeviceToken: z.string().min(10).max(256).optional(),
  deviceIdentifier: z.string().min(6).max(256).optional(),
  deviceName: z.string().max(120).optional(),
  locationLabel: z.string().max(120).optional(),
};

export const registerRequestValidator = z.object({
  fullName: z
    .string()
    .trim()
    .min(2, "Full name must be at least 2 characters")
    .max(120, "Full name must be at most 120 characters"),
  email: emailField,
  role: z.string().optional(),
});

export const registerVerifyValidator = z.object({
  email: emailField,
  code: codeField,
  ...deviceFields,
});

export const loginValidator = z
  .object({
    email: emailField.optional(),
    username: z.string().min(3).optional(),
    ...deviceFields,
  })
  .refine((value) => value.email || value.username, {
    message: "Email is required",
    path: ["email"],
  });

export const loginVerifyValidator = z.object({
  email: emailField,
  code: codeField,
  ...deviceFields,
});

export const googleAuthValidator = z.object({
  idToken: z.string().min(1, "Google credential is required"),
  intent: z.enum(["login", "register"]),
  mode: z.enum(["student", "instructor"]).optional(),
  ...deviceFields,
});

export const refreshValidator = z.object({
  refreshToken: z.string().min(1),
});
