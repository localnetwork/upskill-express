import { Router } from "express";
import { authenticate } from "../../shared/middleware/auth.middleware.js";
import { cacheGetResponse } from "../../shared/middleware/cache.middleware.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import {
  createAnnouncementCommentController,
  getNotificationController,
  listAnnouncementCommentsController,
  listNotificationsController,
  markNotificationReadController,
} from "./notification.controller.js";
import { validate } from "../../shared/middleware/validate.middleware.js";
import { createAnnouncementCommentValidator } from "./notification.validator.js";

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
router.get(
  "/:notificationId",
  cacheGetResponse({
    prefix: "notifications:detail",
    ttlSeconds: 20,
    varyByUser: true,
    tags: ["notifications"],
  }),
  asyncHandler(getNotificationController),
);
router.post("/:notificationId/read", asyncHandler(markNotificationReadController));
router.get(
  "/:notificationId/comments",
  asyncHandler(listAnnouncementCommentsController),
);
router.post(
  "/:notificationId/comments",
  validate(createAnnouncementCommentValidator),
  asyncHandler(createAnnouncementCommentController),
);

export default router;
