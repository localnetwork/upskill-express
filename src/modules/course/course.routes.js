import { Router } from "express";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { authenticate } from "../../shared/middleware/auth.middleware.js";
import { authorize } from "../../shared/middleware/rbac.middleware.js";
import { validate } from "../../shared/middleware/validate.middleware.js";
import {
  createCourseController,
  deleteDraftCourseController,
  getCourseBySlugController,
  listCoursesController,
  publishCourseController,
  submitCourseController,
  updateCourseController,
} from "./course.controller.js";
import { createCourseValidator, updateCourseValidator } from "./course.validator.js";

const router = Router();

router.get("/", asyncHandler(listCoursesController));
router.get("/:slug", asyncHandler(getCourseBySlugController));

router.post("/", authenticate, authorize("EDUCATOR"), validate(createCourseValidator), asyncHandler(createCourseController));
router.patch("/:courseId", authenticate, authorize("EDUCATOR"), validate(updateCourseValidator), asyncHandler(updateCourseController));
router.delete("/:courseId", authenticate, authorize("EDUCATOR"), asyncHandler(deleteDraftCourseController));
router.post("/:courseId/submit", authenticate, authorize("EDUCATOR"), asyncHandler(submitCourseController));
router.post("/:courseId/publish", authenticate, authorize("EDUCATOR"), asyncHandler(publishCourseController));

export default router;
