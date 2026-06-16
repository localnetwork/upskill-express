import { Router } from "express";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { authenticate, authenticateOptional } from "../../shared/middleware/auth.middleware.js";
import { authorize } from "../../shared/middleware/rbac.middleware.js";
import { validate } from "../../shared/middleware/validate.middleware.js";
import { cacheGetResponse } from "../../shared/middleware/cache.middleware.js";
import {
  createCourseController,
  deleteDraftCourseController,
  getCourseForManagementController,
  getCourseStudentsForManagementController,
  getCourseForLearnerController,
  getCourseRouteController,
  getCourseBySlugController,
  listAuthoredCoursesController,
  listCoursesController,
  publishCourseController,
  submitCourseController,
  unpublishCourseController,
  updateCourseGoalsController,
  updateCoursePricingController,
  updateCourseMessagesController,
  updateCourseController,
} from "./course.controller.js";
import { createCourseValidator, updateCourseValidator } from "./course.validator.js";

const router = Router();

router.get(
  "/",
  authenticateOptional,
  cacheGetResponse({
    prefix: "courses:list",
    ttlSeconds: 120,
    varyByUser: true,
    tags: ["courses"],
  }),
  asyncHandler(listCoursesController),
);
router.get(
  "/authored",
  authenticate,
  authorize("EDUCATOR"),
  cacheGetResponse({
    prefix: "courses:authored",
    ttlSeconds: 90,
    varyByUser: true,
    tags: ["courses"],
  }),
  asyncHandler(listAuthoredCoursesController),
);
router.get(
  "/route/:slug",
  authenticateOptional,
  cacheGetResponse({
    prefix: "courses:route",
    ttlSeconds: 120,
    varyByUser: true,
    tags: ["courses"],
  }),
  asyncHandler(getCourseRouteController),
);
router.get(
  "/:slug/learn",
  authenticate,
  authorize("LEARNER"),
  cacheGetResponse({
    prefix: "courses:learn:v2",
    ttlSeconds: 60,
    varyByUser: true,
    tags: ["courses", "progress", "enrollments"],
  }),
  asyncHandler(getCourseForLearnerController),
);
router.get(
  "/:slug/manage",
  authenticate,
  cacheGetResponse({
    prefix: "courses:manage",
    ttlSeconds: 60,
    varyByUser: true,
    tags: ["courses"],
  }),
  asyncHandler(getCourseForManagementController),
);
router.get(
  "/:slug/students",
  authenticate,
  cacheGetResponse({
    prefix: "courses:students",
    ttlSeconds: 60,
    varyByUser: true,
    tags: ["courses", "enrollments", "progress"],
  }),
  asyncHandler(getCourseStudentsForManagementController),
);
router.get(
  "/:slug",
  cacheGetResponse({
    prefix: "courses:detail",
    ttlSeconds: 180,
    tags: ["courses"],
  }),
  asyncHandler(getCourseBySlugController),
);

router.post("/", authenticate, authorize("EDUCATOR"), validate(createCourseValidator), asyncHandler(createCourseController));
router.patch("/:courseId", authenticate, authorize("EDUCATOR"), validate(updateCourseValidator), asyncHandler(updateCourseController));
router.put("/:courseId", authenticate, authorize("EDUCATOR"), validate(updateCourseValidator), asyncHandler(updateCourseController));
router.put("/:courseId/pricing", authenticate, authorize("EDUCATOR"), asyncHandler(updateCoursePricingController));
router.put("/:courseId/goals", authenticate, authorize("EDUCATOR"), asyncHandler(updateCourseGoalsController));
router.put("/:courseId/messages", authenticate, authorize("EDUCATOR"), asyncHandler(updateCourseMessagesController));
router.delete("/:courseId", authenticate, authorize("EDUCATOR"), asyncHandler(deleteDraftCourseController));
router.post("/:courseId/submit", authenticate, authorize("EDUCATOR"), asyncHandler(submitCourseController));
router.post("/:courseId/publish", authenticate, authorize("EDUCATOR"), asyncHandler(publishCourseController));
router.put("/:courseId/unpublish", authenticate, authorize("EDUCATOR"), asyncHandler(unpublishCourseController));

export default router;
