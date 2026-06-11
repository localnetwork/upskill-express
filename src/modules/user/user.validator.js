import { z } from "zod";

export const createdUserValidator = z.object({
  username: z.string().min(3).max(40),
  email: z.string().email("Invalid email format"),

  password: z.string().min(8, "Password must be at least 8 characters"),

  firstName: z.string().optional(),
  lastName: z.string().optional(),
  firstname: z.string().optional(),
  lastname: z.string().optional(),
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
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  firstname: z.string().optional(),
  lastname: z.string().optional(),
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
  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .optional(),
});
