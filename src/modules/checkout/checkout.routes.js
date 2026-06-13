import { Router } from "express";
import { authenticate, authenticateOptional } from "../../shared/middleware/auth.middleware.js";
import { authorize } from "../../shared/middleware/rbac.middleware.js";
import { validate } from "../../shared/middleware/validate.middleware.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import {
  cancelCheckoutController,
  captureCheckoutController,
  createCheckoutController,
  getCheckoutStatusController,
  webhookController,
} from "./checkout.controller.js";
import {
  cancelCheckoutValidator,
  captureCheckoutValidator,
  checkoutStatusValidator,
  createCheckoutValidator,
} from "./checkout.validator.js";

const router = Router();

router.post(
  "/",
  authenticate,
  authorize("LEARNER"),
  validate(createCheckoutValidator),
  asyncHandler(createCheckoutController),
);

router.post(
  "/cancel",
  authenticateOptional,
  validate(cancelCheckoutValidator),
  asyncHandler(cancelCheckoutController),
);

router.post(
  "/capture",
  authenticateOptional,
  validate(captureCheckoutValidator),
  asyncHandler(captureCheckoutController),
);

router.get(
  "/status/:providerOrderId",
  authenticateOptional,
  validate(checkoutStatusValidator, "params"),
  asyncHandler(getCheckoutStatusController),
);

router.post("/webhook/paypal", asyncHandler(webhookController));

export default router;
