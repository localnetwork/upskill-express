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
  title: z.string().min(3).max(60),
  slug: z.string().min(2).max(150).optional(),
  subtitle: z.string().optional(),
  description: z.string().optional(),
  welcomeMessage: z.string().optional().nullable(),
  welcome_message: z.string().optional().nullable(),
  congratulationsMessage: z.string().optional().nullable(),
  congratulations_message: z.string().optional().nullable(),
  categoryId: z.string().optional().nullable(),
  category_id: z.string().optional().nullable(),
  category_ids: z.array(categoryRefSchema).optional(),
  levelId: z.union([z.string(), z.number().int()]).optional().nullable(),
  instructional_level: z
    .union([z.string(), z.number().int()])
    .optional()
    .nullable(),
  priceTierId: z.string().optional().nullable(),
  price_tier: z.string().optional().nullable(),
  language: z.string().optional(),
  promo_video: z.union([z.string(), mediaRefSchema]).optional().nullable(),
  cover_image: z.union([z.string(), mediaRefSchema]).optional().nullable(),
  published: z.union([z.boolean(), z.literal("0"), z.literal("1")]).optional(),
  status: z
    .union([z.number().int(), z.literal("0"), z.literal("1")])
    .optional(),
});

export const updateCourseValidator = createCourseValidator.partial();

export const createCourseCouponValidator = z.object({
  code: z.string().min(3).max(64),
  couponType: z
    .enum(["CURRENT_BEST_PRICE", "CUSTOM_PRICE", "FREE_OPEN", "FREE_TARGETED"])
    .optional(),
  salePrice: z.coerce.number().min(0),
  startAt: z.string().optional().nullable(),
  endAt: z.string().optional().nullable(),
  maxRedemptions: z.coerce.number().int().positive().optional().nullable(),
});

export const createCourseAIDraftValidator = z.object({
  prompt: z.string().min(20).max(4000),
  language: z.string().max(100).optional(),
  instructional_level: z.string().max(120).optional(),
});

export const learnAssistantValidator = z.object({
  message: z.string().min(2).max(4000),
  lecture_id: z.string().optional().nullable(),
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().min(1).max(2000),
      }),
    )
    .max(20)
    .optional(),
});

export const updateCourseWithAIValidator = z.object({
  target: z
    .enum(["auto", "course_basics", "section", "curriculum", "new_section"])
    .optional(),
  prompt: z.string().min(20).max(4000),
  section_id: z.string().optional().nullable(),
  curriculum_id: z.string().optional().nullable(),
});
