import { Router } from "express";
import { authenticate } from "../../shared/middleware/auth.middleware.js";
import { authorize, authorizePermission } from "../../shared/middleware/rbac.middleware.js";
import { validate } from "../../shared/middleware/validate.middleware.js";
import { cacheGetResponse } from "../../shared/middleware/cache.middleware.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import {
  activityReportController,
  approveCourseController,
  createRoleController,
  deleteRoleController,
  getPlatformSettingsController,
  listAdminCoursesController,
  listPermissionsController,
  listRolesController,
  rejectCourseController,
  revenueReportController,
  setRolePermissionsController,
  setUserStaffRolesController,
  createUserByAdminController,
  updatePlatformSettingsController,
} from "./admin.controller.js";
import {
  createRoleValidator,
  reviewCourseValidator,
  setRolePermissionsValidator,
  setUserStaffRolesValidator,
  createUserByAdminValidator,
  updatePlatformSettingsValidator,
} from "./admin.validator.js";

const router = Router();

router.use(authenticate);
router.get("/permissions", authorize("ADMIN"), asyncHandler(listPermissionsController));
router.get("/roles", authorize("ADMIN"), asyncHandler(listRolesController));
router.post("/roles", authorize("ADMIN"), validate(createRoleValidator), asyncHandler(createRoleController));
router.put(
  "/roles/:roleId/permissions",
  authorize("ADMIN"),
  validate(setRolePermissionsValidator),
  asyncHandler(setRolePermissionsController),
);
router.post(
  "/users",
  authorize("ADMIN"),
  validate(createUserByAdminValidator),
  asyncHandler(createUserByAdminController),
);
router.put(
  "/users/:userId/roles",
  authorize("ADMIN"),
  validate(setUserStaffRolesValidator),
  asyncHandler(setUserStaffRolesController),
);
router.delete("/roles/:roleId", authorize("ADMIN"), asyncHandler(deleteRoleController));
router.get(
  "/courses",
  authorizePermission("courses.list", "courses.approve", "courses.reject"),
  cacheGetResponse({
    prefix: "admin:courses",
    ttlSeconds: 60,
    varyByUser: true,
    tags: ["admin-courses", "courses"],
  }),
  asyncHandler(listAdminCoursesController),
);
router.post("/courses/:courseId/approve", authorizePermission("courses.approve"), validate(reviewCourseValidator), asyncHandler(approveCourseController));
router.post("/courses/:courseId/reject", authorizePermission("courses.reject"), validate(reviewCourseValidator), asyncHandler(rejectCourseController));
router.get(
  "/reports/activity",
  authorizePermission("reports.view"),
  cacheGetResponse({
    prefix: "admin:activity-report",
    ttlSeconds: 60,
    varyByUser: true,
    tags: ["admin-revenue", "activity", "courses"],
  }),
  asyncHandler(activityReportController),
);
router.get(
  "/reports/revenue",
  authorizePermission("reports.revenue"),
  cacheGetResponse({
    prefix: "admin:revenue-report",
    ttlSeconds: 60,
    varyByUser: true,
    tags: ["admin-revenue", "payouts", "orders"],
  }),
  asyncHandler(revenueReportController),
);
router.get(
  "/platform-settings",
  authorizePermission("settings.view", "settings.manage"),
  cacheGetResponse({
    prefix: "admin:platform-settings",
    ttlSeconds: 120,
    varyByUser: true,
    tags: ["admin-revenue", "courses"],
  }),
  asyncHandler(getPlatformSettingsController),
);
router.put(
  "/platform-settings",
  authorizePermission("settings.manage"),
  validate(updatePlatformSettingsValidator),
  asyncHandler(updatePlatformSettingsController),
);

export default router;
