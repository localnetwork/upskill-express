import { Router } from "express";
import { authenticate } from "../../shared/middleware/auth.middleware.js";
import { authorize, authorizePermission } from "../../shared/middleware/rbac.middleware.js";
import { validate } from "../../shared/middleware/validate.middleware.js";
import { cacheGetResponse } from "../../shared/middleware/cache.middleware.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import {
  approvePayoutController,
  connectPayoutAccountController,
  executePayoutController,
  listAllPayoutsController,
  listMyPayoutsController,
  myPayoutSummaryController,
  payoutWebhookController,
  rejectPayoutController,
  requestPayoutController,
  retryMyPayoutController,
  returnMyPayoutController,
  runAutoPayoutController,
  verifyAccountPasswordController,
  accountVerificationMethodController,
} from "./payout.controller.js";
import {
  connectPayoutAccountValidator,
  requestPayoutValidator,
  reviewPayoutValidator,
  verifyPasswordValidator,
} from "./payout.validator.js";

const router = Router();

router.post("/webhook/xendit", asyncHandler(payoutWebhookController));

router.get(
  "/account/verification-method",
  authenticate,
  authorize("EDUCATOR"),
  asyncHandler(accountVerificationMethodController),
);
router.post(
  "/account/verify-password",
  authenticate,
  authorize("EDUCATOR"),
  validate(verifyPasswordValidator),
  asyncHandler(verifyAccountPasswordController),
);

router.post(
  "/account",
  authenticate,
  authorize("EDUCATOR"),
  validate(connectPayoutAccountValidator),
  asyncHandler(connectPayoutAccountController),
);
router.post(
  "/request",
  authenticate,
  authorize("EDUCATOR"),
  validate(requestPayoutValidator),
  asyncHandler(requestPayoutController),
);
router.post(
  "/my/:payoutId/retry",
  authenticate,
  authorize("EDUCATOR"),
  asyncHandler(retryMyPayoutController),
);
router.post(
  "/my/:payoutId/return",
  authenticate,
  authorize("EDUCATOR"),
  asyncHandler(returnMyPayoutController),
);
router.get(
  "/summary",
  authenticate,
  authorize("EDUCATOR"),
  cacheGetResponse({
    prefix: "payouts:summary",
    ttlSeconds: 60,
    varyByUser: true,
    tags: ["payouts"],
  }),
  asyncHandler(myPayoutSummaryController),
);
router.get(
  "/my",
  authenticate,
  authorize("EDUCATOR"),
  cacheGetResponse({
    prefix: "payouts:my",
    ttlSeconds: 60,
    varyByUser: true,
    tags: ["payouts"],
  }),
  asyncHandler(listMyPayoutsController),
);

router.get(
  "/admin",
  authenticate,
  authorizePermission("payouts.manage"),
  cacheGetResponse({
    prefix: "payouts:admin",
    ttlSeconds: 60,
    varyByUser: true,
    tags: ["payouts"],
  }),
  asyncHandler(listAllPayoutsController),
);
router.post(
  "/admin/auto-process",
  authenticate,
  authorizePermission("payouts.manage"),
  asyncHandler(runAutoPayoutController),
);
router.post(
  "/admin/:payoutId/approve",
  authenticate,
  authorizePermission("payouts.manage"),
  validate(reviewPayoutValidator),
  asyncHandler(approvePayoutController),
);
router.post(
  "/admin/:payoutId/reject",
  authenticate,
  authorizePermission("payouts.manage"),
  validate(reviewPayoutValidator),
  asyncHandler(rejectPayoutController),
);
router.post(
  "/admin/:payoutId/execute",
  authenticate,
  authorizePermission("payouts.manage"),
  asyncHandler(executePayoutController),
);

export default router;
