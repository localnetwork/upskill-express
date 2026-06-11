import { z } from "zod";

const categorySchema = z.object({
  name: z.string().min(2).max(120).optional(),
  title: z.string().min(2).max(120).optional(),
  slug: z.string().min(2).max(160),
  description: z.string().optional(),
  category_description: z.string().optional(),
  parentId: z.string().optional().nullable(),
  parent_id: z.string().optional().nullable(),
});

export const createCategoryValidator = categorySchema
  .refine((value) => Boolean(value.name || value.title), {
    message: "name or title is required",
    path: ["name"],
  });

export const updateCategoryValidator = categorySchema.partial();
