import { z } from "zod";

export const createReviewValidator = z.object({
  courseId: z.string(),
  rating: z.number().int().min(1).max(5),
  title: z.string().optional(),
  comment: z.string().optional(),
});

export const reviewCourseParamsValidator = z.object({
  courseId: z.string().min(1),
});

export const reviewLikeParamsValidator = z.object({
  reviewId: z.string().min(1),
});

export const instructorCourseReviewsParamsValidator = z.object({
  slug: z.string().min(1),
});

export const listInstructorReviewsValidator = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  search: z.string().optional(),
  q: z.string().optional(),
  courseId: z.string().optional(),
  courseSlug: z.string().optional(),
  rating: z.coerce.number().int().min(1).max(5).optional(),
  sort: z.enum(["recent", "highest", "lowest"]).optional(),
});
