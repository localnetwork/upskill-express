import { Router } from "express";
import { authenticate } from "../../shared/middleware/auth.middleware.js";
import { authorize } from "../../shared/middleware/rbac.middleware.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { cacheGetResponse } from "../../shared/middleware/cache.middleware.js";
import { getMyLearningPathsController } from "./learning-path.controller.js";

const router = Router();
router.use(authenticate, authorize("LEARNER"));
router.get(
  "/me",
  cacheGetResponse({
    prefix: "learning-paths:me",
    ttlSeconds: 60,
    varyByUser: true,
    tags: ["enrollments", "courses", "progress", "wishlist"],
  }),
  asyncHandler(getMyLearningPathsController),
);

export default router;
