import { z } from "zod";

export const trackActivityEventValidator = z.object({
  eventType: z.enum([
    "AUTH_REGISTER",
    "AUTH_LOGIN",
    "ACCOUNT_PROFILE_UPDATED",
    "LEARNING_LESSON_PROGRESS",
    "LEARNING_COURSE_COMPLETED",
    "LEARNING_REVIEW_CREATED",
    "COMMERCE_CART_ADD",
    "COMMERCE_WISHLIST_ADD",
    "COMMERCE_CHECKOUT_CREATED",
    "COMMERCE_PURCHASE_COMPLETED",
    "COURSE_IMPRESSION",
    "COURSE_PAGE_VIEW",
  ]),
  courseId: z.string().optional(),
  courseSlug: z.string().optional(),
  pagePath: z.string().max(500).optional(),
  sessionKey: z.string().max(120).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  dedupeWindowSeconds: z.coerce.number().int().min(0).max(300).optional(),
});

