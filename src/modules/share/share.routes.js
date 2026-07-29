import { Router } from "express";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { cacheGetResponse } from "../../shared/middleware/cache.middleware.js";
import {
  createOrGetCourseShareLinkController,
  resolveCourseShareLinkController,
} from "./share.controller.js";

const router = Router();

router.post(
  "/courses/:slug",
  asyncHandler(createOrGetCourseShareLinkController),
);

router.get(
  "/:code",
  cacheGetResponse({
    prefix: "share:course-link",
    ttlSeconds: 600,
    tags: ["courses"],
  }),
  asyncHandler(resolveCourseShareLinkController),
);

export default router;
