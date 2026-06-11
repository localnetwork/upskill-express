import { Router } from "express";
import { authenticate } from "../../shared/middleware/auth.middleware.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { listNotificationsController, markNotificationReadController } from "./notification.controller.js";

const router = Router();

router.use(authenticate);
router.get("/", asyncHandler(listNotificationsController));
router.post("/:notificationId/read", asyncHandler(markNotificationReadController));

export default router;
