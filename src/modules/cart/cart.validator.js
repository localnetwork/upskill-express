import { z } from "zod";

export const addToCartValidator = z.object({
  courseId: z.string().optional(),
  course_id: z.string().optional(),
});

export const removeCartItemValidator = z.object({
  courseId: z.string().optional(),
  itemId: z.string().optional(),
});
