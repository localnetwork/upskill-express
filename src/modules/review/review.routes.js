import { Router } from "express";
import { authenticate, authenticateOptional } from "../../shared/middleware/auth.middleware.js";
import { authorize } from "../../shared/middleware/rbac.middleware.js";
import { validate } from "../../shared/middleware/validate.middleware.js";
import { cacheGetResponse } from "../../shared/middleware/cache.middleware.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import {
  createReviewController,
  getReviewEligibilityController,
  listCourseReviewsController,
  listInstructorReviewsController,
  toggleReviewLikeController,
} from "./review.controller.js";
import {
  createReviewValidator,
  listInstructorReviewsValidator,
  reviewLikeParamsValidator,
  reviewCourseParamsValidator,
} from "./review.validator.js";

const router = Router();

router.get(
  "/courses/:courseId",
  authenticateOptional,
  validate(reviewCourseParamsValidator, "params"),
  cacheGetResponse({
    prefix: "reviews:course",
    ttlSeconds: 120,
    varyByUser: true,
    tags: (req) => ["reviews", `reviews:course:${req.params.courseId}`],
  }),
  asyncHandler(listCourseReviewsController),
);
router.get(
  "/courses/:courseId/eligibility",
  authenticateOptional,
  validate(reviewCourseParamsValidator, "params"),
  cacheGetResponse({
    prefix: "reviews:eligibility",
    ttlSeconds: 30,
    varyByUser: true,
    tags: (req) => ["reviews", `reviews:course:${req.params.courseId}`],
  }),
  asyncHandler(getReviewEligibilityController),
);
router.get(
  "/instructor",
  authenticate,
  authorize("EDUCATOR"),
  validate(listInstructorReviewsValidator, "query"),
  cacheGetResponse({
    prefix: "reviews:instructor",
    ttlSeconds: 60,
    varyByUser: true,
    tags: ["reviews", "courses"],
  }),
  asyncHandler(listInstructorReviewsController),
);
router.post(
  "/:reviewId/like",
  authenticate,
  validate(reviewLikeParamsValidator, "params"),
  asyncHandler(toggleReviewLikeController),
);
router.post(
  "/",
  authenticate,
  authorize("LEARNER"),
  validate(createReviewValidator),
  asyncHandler(createReviewController),
);

export default router;
