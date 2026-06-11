import { z } from "zod";

const mediaRefSchema = z.object({
  id: z.string().min(1),
  path: z.string().optional(),
  title: z.string().optional(),
});

const categoryRefSchema = z.union([
  z.string().min(1),
  z.number().int(),
  z.object({
    id: z.string().optional(),
    category_id: z.string().optional(),
  }),
]);

export const createCourseValidator = z.object({
  title: z.string().min(3),
  subtitle: z.string().optional(),
  description: z.string().optional(),
  categoryId: z.string().optional().nullable(),
  category_id: z.string().optional().nullable(),
  category_ids: z.array(categoryRefSchema).optional(),
  levelId: z.union([z.string(), z.number().int()]).optional().nullable(),
  instructional_level: z.union([z.string(), z.number().int()]).optional().nullable(),
  priceTierId: z.string().optional().nullable(),
  price_tier: z.string().optional().nullable(),
  language: z.string().optional(),
  promo_video: z.union([z.string(), mediaRefSchema]).optional().nullable(),
  cover_image: z.union([z.string(), mediaRefSchema]).optional().nullable(),
  published: z.union([z.boolean(), z.literal("0"), z.literal("1")]).optional(),
  status: z.union([z.number().int(), z.literal("0"), z.literal("1")]).optional(),
});

export const updateCourseValidator = createCourseValidator.partial();
