import { z } from "zod";

export const createdUserValidator = z.object({
  username: z.string().min(3).max(40),
  email: z.string().email("Invalid email format"),

  fullName: z.string().trim().max(120).optional(),
  headline: z.string().max(100).optional(),
  biography: z.string().optional(),
  link_website: z.string().optional(),
  link_x: z.string().optional(),
  link_linkedin: z.string().optional(),
  link_instagram: z.string().optional(),
  link_facebook: z.string().optional(),
  link_tiktok: z.string().optional(),
  link_youtube: z.string().optional(),
  link_github: z.string().optional(),
});

export const updateUserValidator = z.object({
  username: z.string().min(3).max(40).optional(),
  fullName: z.string().trim().max(120).optional(),
  headline: z.string().max(100).optional(),
  biography: z.string().optional(),
  link_website: z.string().optional(),
  link_x: z.string().optional(),
  link_linkedin: z.string().optional(),
  link_instagram: z.string().optional(),
  link_facebook: z.string().optional(),
  link_tiktok: z.string().optional(),
  link_youtube: z.string().optional(),
  link_github: z.string().optional(),
});

export const changeEmailRequestValidator = z.object({
  newEmail: z.string().trim().toLowerCase().email("Invalid email format"),
});

export const changeEmailConfirmValidator = z.object({
  newEmail: z.string().trim().toLowerCase().email("Invalid email format"),
  code: z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Enter the 6-digit code"),
});

export const friendRequestTargetParamValidator = z.object({
  targetUserId: z.string().min(1, "Target user is required"),
});

export const friendRequestRespondParamValidator = z.object({
  requestId: z.string().min(1, "Request id is required"),
});

export const friendRequestRespondBodyValidator = z.object({
  action: z.enum(["ACCEPT", "DECLINE"]),
});

export const adminUpdateUserValidator = z.object({
  fullName: z.string().trim().max(120).optional(),
  headline: z.string().max(100).optional(),
  biography: z.string().max(2000).optional(),
});

export const adminSuspendUserValidator = z.object({ suspended: z.boolean() });

export const updatePreferencesValidator = z.object({
  occupationId: z.string().min(1).nullable().optional(),
  occupationCustom: z.string().max(100).nullable().optional(),
  topicIds: z.array(z.string().min(1)).max(50).default([]),
});
