import { z } from "zod";

export const createCourseValidator = z.object({
  title: z.string().min(3),
  subtitle: z.string().optional(),
  description: z.string().optional(),
  categoryId: z.string().optional().nullable(),
  levelId: z.string().optional().nullable(),
  priceTierId: z.string().optional().nullable(),
  language: z.string().optional(),
});

export const updateCourseValidator = createCourseValidator.partial();
