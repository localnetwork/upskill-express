import { Router } from "express";
import { authenticate, authenticateOptional } from "../../shared/middleware/auth.middleware.js";
import { authorize } from "../../shared/middleware/rbac.middleware.js";
import { validate } from "../../shared/middleware/validate.middleware.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import {
  captureCheckoutController,
  createCheckoutController,
  getCheckoutStatusController,
  webhookController,
} from "./checkout.controller.js";
import {
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
  "/capture",
  authenticateOptional,
  validate(captureCheckoutValidator),
  asyncHandler(captureCheckoutController),
);

router.get(
  "/status/:providerOrderId",
  authenticate,
  validate(checkoutStatusValidator, "params"),
  asyncHandler(getCheckoutStatusController),
);

router.post("/webhook/paypal", asyncHandler(webhookController));

export default router;
