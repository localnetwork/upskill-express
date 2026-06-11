import { Router } from "express";
import { authenticate } from "../../shared/middleware/auth.middleware.js";
import { authorize } from "../../shared/middleware/rbac.middleware.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { validate } from "../../shared/middleware/validate.middleware.js";
import { upload } from "../../shared/middleware/upload.middleware.js";
import {
  createLessonController,
  createSectionController,
  uploadLessonResourceController,
  uploadLessonVideoController,
} from "./curriculum.controller.js";
import { createLessonValidator, createSectionValidator } from "./curriculum.validator.js";

const router = Router();

router.post(
  "/courses/:courseId/sections",
  authenticate,
  authorize("EDUCATOR"),
  validate(createSectionValidator),
  asyncHandler(createSectionController),
);

router.post(
  "/courses/:courseId/sections/:sectionId/lessons",
  authenticate,
  authorize("EDUCATOR"),
  validate(createLessonValidator),
  asyncHandler(createLessonController),
);

router.post(
  "/courses/:courseId/lessons/:lessonId/video",
  authenticate,
  authorize("EDUCATOR"),
  upload.single("file"),
  asyncHandler(uploadLessonVideoController),
);

router.post(
  "/courses/:courseId/lessons/:lessonId/resource",
  authenticate,
  authorize("EDUCATOR"),
  upload.single("file"),
  asyncHandler(uploadLessonResourceController),
);

export default router;
