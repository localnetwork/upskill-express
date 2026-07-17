import { z } from "zod";

export const connectPayoutAccountValidator = z.object({
  paypalEmail: z.string().email(),
  paypalMerchantId: z.string().optional(),
});

export const requestPayoutValidator = z.object({
  amount: z.number().positive().min(500).optional(),
  note: z.string().optional(),
});

export const reviewPayoutValidator = z.object({
  reviewNote: z.string().optional(),
});
