import { z } from "zod";

export const createdUserValidator = z.object({
  username: z.string().min(3).max(40),
  email: z.string().email("Invalid email format"),

  password: z.string().min(8, "Password must be at least 8 characters"),

  firstName: z.string().optional(),

  lastName: z.string().optional(),
});

export const updateUserValidator = z.object({
  username: z.string().min(3).max(40).optional(),
  firstName: z.string().optional(),

  lastName: z.string().optional(),

  password: z
    .string()
    .min(8, "Password must be at least 8 characters")
    .optional(),
});
