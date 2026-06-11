import { z } from "zod";

export const addToCartValidator = z.object({
  courseId: z.string(),
});
