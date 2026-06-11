import { Router } from "express";
import { authenticate } from "../../shared/middleware/auth.middleware.js";
import { authorize } from "../../shared/middleware/rbac.middleware.js";
import { validate } from "../../shared/middleware/validate.middleware.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { getCourseProgressController, updateLessonProgressController } from "./progress.controller.js";
import { updateLessonProgressValidator } from "./progress.validator.js";

const router = Router();
router.use(authenticate, authorize("LEARNER"));
router.post("/lessons", validate(updateLessonProgressValidator), asyncHandler(updateLessonProgressController));
router.get("/courses/:courseId", asyncHandler(getCourseProgressController));

export default router;
