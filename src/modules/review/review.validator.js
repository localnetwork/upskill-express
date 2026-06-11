import { z } from "zod";

export const createReviewValidator = z.object({
  courseId: z.string(),
  rating: z.number().int().min(1).max(5),
  title: z.string().optional(),
  comment: z.string().optional(),
});
