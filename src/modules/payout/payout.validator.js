import { z } from "zod";
import { XENDIT_PAYOUT_CHANNELS } from "../checkout/xendit.service.js";

const channelCodes = Object.keys(XENDIT_PAYOUT_CHANNELS);

export const connectPayoutAccountValidator = z
  .object({
    channelCode: z.string().refine((value) => channelCodes.includes(value), {
      message: "Unsupported payout channel",
    }),
    accountHolderName: z.string().trim().min(2).max(100),
    accountNumber: z
      .string()
      .trim()
      .regex(/^\d{8,20}$/, "Account number must be 8-20 digits"),
    code: z.string().regex(/^\d{6}$/).optional(),
  })
  .refine(
    (value) =>
      XENDIT_PAYOUT_CHANNELS[value.channelCode]?.type !== "EWALLET" ||
      /^09\d{9}$/.test(value.accountNumber),
    {
      message: "E-wallet number must be an 11-digit mobile number (09XXXXXXXXX)",
      path: ["accountNumber"],
    },
  );

export const verifyPasswordValidator = z.object({
  code: z.string().max(10).optional(),
});

export const requestPayoutValidator = z.object({
  amount: z.number().positive().min(500).optional(),
  note: z.string().optional(),
});

export const reviewPayoutValidator = z.object({
  reviewNote: z.string().optional(),
});
