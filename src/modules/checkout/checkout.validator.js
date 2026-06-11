import { z } from "zod";

export const createCheckoutValidator = z.object({
  couponCode: z.string().optional(),
  taxRegionCode: z.string().optional(),
});

export const captureCheckoutValidator = z.object({
  providerOrderId: z.string().min(3),
});
