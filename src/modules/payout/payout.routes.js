import { Router } from "express";
import { authenticate } from "../../shared/middleware/auth.middleware.js";
import { authorize } from "../../shared/middleware/rbac.middleware.js";
import { validate } from "../../shared/middleware/validate.middleware.js";
import { cacheGetResponse } from "../../shared/middleware/cache.middleware.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import {
  approvePayoutController,
  connectPayoutAccountController,
  executePayoutController,
  listAllPayoutsController,
  listMyPayoutsController,
  rejectPayoutController,
  requestPayoutController,
} from "./payout.controller.js";
import {
  connectPayoutAccountValidator,
  requestPayoutValidator,
  reviewPayoutValidator,
} from "./payout.validator.js";

const router = Router();

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
  authorize("ADMIN"),
  cacheGetResponse({
    prefix: "payouts:admin",
    ttlSeconds: 60,
    varyByUser: true,
    tags: ["payouts"],
  }),
  asyncHandler(listAllPayoutsController),
);
router.post(
  "/admin/:payoutId/approve",
  authenticate,
  authorize("ADMIN"),
  validate(reviewPayoutValidator),
  asyncHandler(approvePayoutController),
);
router.post(
  "/admin/:payoutId/reject",
  authenticate,
  authorize("ADMIN"),
  validate(reviewPayoutValidator),
  asyncHandler(rejectPayoutController),
);
router.post(
  "/admin/:payoutId/execute",
  authenticate,
  authorize("ADMIN"),
  asyncHandler(executePayoutController),
);

export default router;
