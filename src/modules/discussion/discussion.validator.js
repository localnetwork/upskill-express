import { z } from "zod";

export const listDiscussionsValidator = z.object({
  lessonId: z.string().trim().min(1),
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  status: z.enum(["all", "open", "resolved"]).optional(),
  category: z.enum(["all", "COURSE_CONTENT", "SOMETHING_ELSE"]).optional(),
  sort: z.enum(["newest", "oldest", "most_upvoted"]).optional(),
});

export const createDiscussionThreadValidator = z.object({
  lessonId: z.string().trim().min(1),
  category: z.enum(["COURSE_CONTENT", "SOMETHING_ELSE"]).optional(),
  imagePath: z.string().trim().max(2048).optional().nullable(),
  title: z.string().trim().min(3).max(180),
  body: z.string().trim().min(1).max(5000),
});

export const createDiscussionReplyValidator = z.object({
  body: z.string().trim().min(1).max(5000),
  parentReplyId: z.string().trim().optional().nullable(),
});

export const toggleDiscussionResolvedValidator = z.object({
  isResolved: z.boolean(),
});

export const toggleDiscussionVoteValidator = z.object({
  isUpvoted: z.boolean(),
});
