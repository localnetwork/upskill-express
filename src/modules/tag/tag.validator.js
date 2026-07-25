import { z } from "zod";

const tagSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  title: z.string().min(2).max(120).optional(),
  slug: z.string().min(2).max(150).optional(),
  description: z.string().optional().nullable(),
  categoryId: z.string().optional(),
  category_id: z.string().optional(),
});

export const createTagValidator = tagSchema
  .refine((value) => Boolean(value.name || value.title), {
    message: "name or title is required",
    path: ["name"],
  })
  .refine((value) => Boolean(value.slug), {
    message: "slug is required",
    path: ["slug"],
  })
  .refine((value) => Boolean(value.categoryId || value.category_id), {
    message: "categoryId or category_id is required",
    path: ["categoryId"],
  });

export const updateTagValidator = tagSchema.partial();
