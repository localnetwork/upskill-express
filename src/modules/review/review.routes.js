import { Router } from "express";
import { authenticate } from "../../shared/middleware/auth.middleware.js";
import { authorize } from "../../shared/middleware/rbac.middleware.js";
import { validate } from "../../shared/middleware/validate.middleware.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { createReviewController, listCourseReviewsController } from "./review.controller.js";
import { createReviewValidator } from "./review.validator.js";

const router = Router();

router.get("/courses/:courseId", asyncHandler(listCourseReviewsController));
router.post(
  "/",
  authenticate,
  authorize("LEARNER"),
  validate(createReviewValidator),
  asyncHandler(createReviewController),
);

export default router;
