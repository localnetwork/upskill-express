import { Router } from "express";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { validate } from "../../shared/middleware/validate.middleware.js";
import { createRateLimiter } from "../../shared/middleware/rate-limit.middleware.js";
import {
  emailVerificationValidator,
  forgotPasswordValidator,
  loginValidator,
  refreshValidator,
  registerValidator,
  resetPasswordValidator,
} from "./auth.validator.js";
import {
  forgotPasswordController,
  loginController,
  refreshTokenController,
  registerController,
  resetPasswordController,
  verifyEmailController,
} from "./auth.controller.js";

const router = Router();

const authStrictLimiter = createRateLimiter({
  keyPrefix: "rl:auth:strict",
  windowSeconds: 60,
  maxRequests: 20,
  by: "ip",
  message: "Too many authentication attempts. Please try again shortly.",
});

const authRefreshLimiter = createRateLimiter({
  keyPrefix: "rl:auth:refresh",
  windowSeconds: 60,
  maxRequests: 60,
  by: "ip",
  message: "Too many refresh requests. Please try again shortly.",
});

router.post(
  "/register",
  authStrictLimiter,
  validate(registerValidator),
  asyncHandler(registerController),
);
router.post(
  "/login",
  authStrictLimiter,
  validate(loginValidator),
  asyncHandler(loginController),
);
router.post(
  "/refresh",
  authRefreshLimiter,
  validate(refreshValidator),
  asyncHandler(refreshTokenController),
);
router.post(
  "/forgot-password",
  authStrictLimiter,
  validate(forgotPasswordValidator),
  asyncHandler(forgotPasswordController),
);
router.post(
  "/reset-password",
  authStrictLimiter,
  validate(resetPasswordValidator),
  asyncHandler(resetPasswordController),
);
router.post(
  "/verify-email",
  authStrictLimiter,
  validate(emailVerificationValidator),
  asyncHandler(verifyEmailController),
);

export default router;
