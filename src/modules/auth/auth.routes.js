import { Router } from "express";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { validate } from "../../shared/middleware/validate.middleware.js";
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

router.post("/register", validate(registerValidator), asyncHandler(registerController));
router.post("/login", validate(loginValidator), asyncHandler(loginController));
router.post("/refresh", validate(refreshValidator), asyncHandler(refreshTokenController));
router.post("/forgot-password", validate(forgotPasswordValidator), asyncHandler(forgotPasswordController));
router.post("/reset-password", validate(resetPasswordValidator), asyncHandler(resetPasswordController));
router.post("/verify-email", validate(emailVerificationValidator), asyncHandler(verifyEmailController));

export default router;
