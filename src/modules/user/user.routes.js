import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { authenticate } from "../../shared/middleware/auth.middleware.js";
import { authorize } from "../../shared/middleware/rbac.middleware.js";
import { validate } from "../../shared/middleware/validate.middleware.js";
import { cacheGetResponse } from "../../shared/middleware/cache.middleware.js";
import {
  friendRequestRespondBodyValidator,
  friendRequestRespondParamValidator,
  friendRequestTargetParamValidator,
  updateUserValidator,
} from "./user.validator.js";
import {
  cancelFriendRequestController,
  changePasswordController,
  deleteUserController,
  getFriendRequestStatusController,
  listMyDevicesController,
  listUsersController,
  listMyActivityController,
  meController,
  removeMyDeviceController,
  respondToFriendRequestController,
  sendFriendRequestController,
  unfriendController,
  updateMeController,
} from "./user.controller.js";

const router = Router();

router.get(
  "/me",
  authenticate,
  cacheGetResponse({
    prefix: "users:me",
    ttlSeconds: 60,
    varyByUser: true,
    tags: ["users", "user-profile"],
  }),
  asyncHandler(meController),
);
router.patch("/me", authenticate, validate(updateUserValidator), asyncHandler(updateMeController));
router.get(
  "/me/activity",
  authenticate,
  cacheGetResponse({
    prefix: "users:me:activity",
    ttlSeconds: 30,
    varyByUser: true,
    tags: ["users", "activity"],
  }),
  asyncHandler(listMyActivityController),
);
router.get(
  "/me/devices",
  authenticate,
  cacheGetResponse({
    prefix: "users:me:devices",
    ttlSeconds: 30,
    varyByUser: true,
    tags: ["users", "activity"],
  }),
  asyncHandler(listMyDevicesController),
);
router.delete("/me/devices/:deviceId", authenticate, asyncHandler(removeMyDeviceController));
router.post(
  "/me/change-password",
  authenticate,
  validate(
    z.object({
      oldPassword: z.string().min(8),
      newPassword: z.string().min(8),
    }),
  ),
  asyncHandler(changePasswordController),
);
router.get(
  "/friend-requests/status/:targetUserId",
  authenticate,
  validate(friendRequestTargetParamValidator, "params"),
  asyncHandler(getFriendRequestStatusController),
);
router.post(
  "/friend-requests/send/:targetUserId",
  authenticate,
  validate(friendRequestTargetParamValidator, "params"),
  asyncHandler(sendFriendRequestController),
);
router.post(
  "/friend-requests/cancel/:targetUserId",
  authenticate,
  validate(friendRequestTargetParamValidator, "params"),
  asyncHandler(cancelFriendRequestController),
);
router.post(
  "/friend-requests/unfriend/:targetUserId",
  authenticate,
  validate(friendRequestTargetParamValidator, "params"),
  asyncHandler(unfriendController),
);
router.post(
  "/friend-requests/respond/:requestId",
  authenticate,
  validate(friendRequestRespondParamValidator, "params"),
  validate(friendRequestRespondBodyValidator),
  asyncHandler(respondToFriendRequestController),
);

router.get(
  "/",
  authenticate,
  authorize("ADMIN"),
  cacheGetResponse({
    prefix: "users:list",
    ttlSeconds: 60,
    varyByUser: true,
    tags: ["users"],
  }),
  asyncHandler(listUsersController),
);
router.delete("/:userId", authenticate, authorize("ADMIN"), asyncHandler(deleteUserController));

export default router;
