import { Router } from "express";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { validate } from "../../shared/middleware/validate.middleware.js";
import { createRateLimiter } from "../../shared/middleware/rate-limit.middleware.js";
import {
  googleAuthValidator,
  loginValidator,
  loginVerifyValidator,
  refreshValidator,
  registerRequestValidator,
  registerVerifyValidator,
} from "./auth.validator.js";
import {
  googleAuthController,
  loginController,
  loginVerifyController,
  refreshTokenController,
  registerRequestController,
  registerVerifyController,
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
  validate(registerRequestValidator),
  asyncHandler(registerRequestController),
);
router.post(
  "/register/verify",
  authStrictLimiter,
  validate(registerVerifyValidator),
  asyncHandler(registerVerifyController),
);
router.post(
  "/login",
  authStrictLimiter,
  validate(loginValidator),
  asyncHandler(loginController),
);
router.post(
  "/login/verify",
  authStrictLimiter,
  validate(loginVerifyValidator),
  asyncHandler(loginVerifyController),
);
router.post(
  "/google",
  authStrictLimiter,
  validate(googleAuthValidator),
  asyncHandler(googleAuthController),
);
router.post(
  "/refresh",
  authRefreshLimiter,
  validate(refreshValidator),
  asyncHandler(refreshTokenController),
);

export default router;
