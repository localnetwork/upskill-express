import { z } from "zod";

export const addToWishlistValidator = z.object({
  courseId: z.string().optional(),
  course_id: z.string().optional(),
}).refine((payload) => Boolean(payload.courseId || payload.course_id), {
  message: "courseId or course_id is required",
});
