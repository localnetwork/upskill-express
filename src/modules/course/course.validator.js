import { z } from "zod";

export const createCourseValidator = z.object({
  title: z.string().min(3),
  subtitle: z.string().optional(),
  description: z.string().optional(),
  categoryId: z.string().optional().nullable(),
  category_id: z.string().optional().nullable(),
  levelId: z.union([z.string(), z.number().int()]).optional().nullable(),
  instructional_level: z.union([z.string(), z.number().int()]).optional().nullable(),
  priceTierId: z.string().optional().nullable(),
  price_tier: z.string().optional().nullable(),
  language: z.string().optional(),
  promo_video: z.string().optional().nullable(),
  cover_image: z.string().optional().nullable(),
  published: z.union([z.boolean(), z.literal("0"), z.literal("1")]).optional(),
  status: z.union([z.number().int(), z.literal("0"), z.literal("1")]).optional(),
});

export const updateCourseValidator = createCourseValidator.partial();
