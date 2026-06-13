import { z } from "zod";

export const createCheckoutValidator = z.object({
  couponCode: z.string().optional(),
  taxRegionCode: z.string().optional(),
  courseId: z.string().optional(),
  course_id: z.string().optional(),
});

export const captureCheckoutValidator = z.object({
  providerOrderId: z.string().min(3),
});

export const cancelCheckoutValidator = z.object({
  providerOrderId: z.string().min(3),
});

export const checkoutStatusValidator = z.object({
  providerOrderId: z.string().min(3),
});
