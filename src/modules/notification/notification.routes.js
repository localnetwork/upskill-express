import { Router } from "express";
import { authenticate } from "../../shared/middleware/auth.middleware.js";
import { cacheGetResponse } from "../../shared/middleware/cache.middleware.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { listNotificationsController, markNotificationReadController } from "./notification.controller.js";

const router = Router();

router.use(authenticate);
router.get(
  "/",
  cacheGetResponse({
    prefix: "notifications:list",
    ttlSeconds: 20,
    varyByUser: true,
    tags: ["notifications"],
  }),
  asyncHandler(listNotificationsController),
);
router.post("/:notificationId/read", asyncHandler(markNotificationReadController));

export default router;
