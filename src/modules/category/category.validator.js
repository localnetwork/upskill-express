import { z } from "zod";

export const createCategoryValidator = z.object({
  name: z.string().min(2).max(120),
  slug: z.string().min(2).max(160),
  description: z.string().optional(),
  parentId: z.string().optional().nullable(),
});

export const updateCategoryValidator = createCategoryValidator.partial();
