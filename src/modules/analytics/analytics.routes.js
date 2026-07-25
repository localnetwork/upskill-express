import { Router } from "express";
import { authenticateOptional } from "../../shared/middleware/auth.middleware.js";
import { cacheGetResponse } from "../../shared/middleware/cache.middleware.js";
import { validate } from "../../shared/middleware/validate.middleware.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import {
  getTrendingTopicsAnalyticsController,
  trackActivityEventController,
} from "./analytics.controller.js";
import {
  trackActivityEventValidator,
  trendingTopicsQueryValidator,
} from "./analytics.validator.js";

const router = Router();

router.post(
  "/events",
  authenticateOptional,
  validate(trackActivityEventValidator),
  asyncHandler(trackActivityEventController),
);

router.get(
  "/topics/trending",
  validate(trendingTopicsQueryValidator, "query"),
  cacheGetResponse({
    prefix: "analytics:topics:trending",
    ttlSeconds: 120,
    tags: ["analytics", "activity", "courses"],
  }),
  asyncHandler(getTrendingTopicsAnalyticsController),
);

export default router;
