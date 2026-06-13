import { Router } from "express";
import { authenticate } from "../../shared/middleware/auth.middleware.js";
import { authorize } from "../../shared/middleware/rbac.middleware.js";
import { validate } from "../../shared/middleware/validate.middleware.js";
import { cacheGetResponse } from "../../shared/middleware/cache.middleware.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { getCourseProgressController, updateLessonProgressController } from "./progress.controller.js";
import { updateLessonProgressValidator } from "./progress.validator.js";

const router = Router();
router.use(authenticate, authorize("LEARNER"));
router.post("/lessons", validate(updateLessonProgressValidator), asyncHandler(updateLessonProgressController));
router.get(
  "/courses/:courseId",
  cacheGetResponse({
    prefix: "progress:course",
    ttlSeconds: 30,
    varyByUser: true,
    tags: ["progress", "courses", "enrollments"],
  }),
  asyncHandler(getCourseProgressController),
);

export default router;
