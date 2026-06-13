import { Router } from "express";
import { authenticate } from "../../shared/middleware/auth.middleware.js";
import { authorize } from "../../shared/middleware/rbac.middleware.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { cacheGetResponse } from "../../shared/middleware/cache.middleware.js";
import { listMyEnrollmentsController } from "./enrollment.controller.js";

const router = Router();
router.use(authenticate, authorize("LEARNER"));
router.get(
  "/",
  cacheGetResponse({
    prefix: "enrollments:my",
    ttlSeconds: 60,
    varyByUser: true,
    tags: ["enrollments", "courses", "progress"],
  }),
  asyncHandler(listMyEnrollmentsController),
);

export default router;
