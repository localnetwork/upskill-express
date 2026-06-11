import { z } from "zod";

export const reviewCourseValidator = z.object({
  note: z.string().optional(),
});
