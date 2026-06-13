import { Router } from "express";
import { authenticate } from "../../shared/middleware/auth.middleware.js";
import { authorize } from "../../shared/middleware/rbac.middleware.js";
import { validate } from "../../shared/middleware/validate.middleware.js";
import { cacheGetResponse } from "../../shared/middleware/cache.middleware.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import {
  approveCourseController,
  listAdminCoursesController,
  rejectCourseController,
  revenueReportController,
} from "./admin.controller.js";
import { reviewCourseValidator } from "./admin.validator.js";

const router = Router();

router.use(authenticate, authorize("ADMIN"));
router.get(
  "/courses",
  cacheGetResponse({
    prefix: "admin:courses",
    ttlSeconds: 60,
    varyByUser: true,
    tags: ["admin-courses", "courses"],
  }),
  asyncHandler(listAdminCoursesController),
);
router.post("/courses/:courseId/approve", validate(reviewCourseValidator), asyncHandler(approveCourseController));
router.post("/courses/:courseId/reject", validate(reviewCourseValidator), asyncHandler(rejectCourseController));
router.get(
  "/reports/revenue",
  cacheGetResponse({
    prefix: "admin:revenue-report",
    ttlSeconds: 60,
    varyByUser: true,
    tags: ["admin-revenue", "payouts", "orders"],
  }),
  asyncHandler(revenueReportController),
);

export default router;
