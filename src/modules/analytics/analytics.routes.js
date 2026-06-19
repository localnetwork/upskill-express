import { Router } from "express";
import { authenticateOptional } from "../../shared/middleware/auth.middleware.js";
import { validate } from "../../shared/middleware/validate.middleware.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { trackActivityEventController } from "./analytics.controller.js";
import { trackActivityEventValidator } from "./analytics.validator.js";

const router = Router();

router.post(
  "/events",
  authenticateOptional,
  validate(trackActivityEventValidator),
  asyncHandler(trackActivityEventController),
);

export default router;

