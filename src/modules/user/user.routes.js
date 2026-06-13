import { Router } from "express";
import { z } from "zod";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { authenticate } from "../../shared/middleware/auth.middleware.js";
import { authorize } from "../../shared/middleware/rbac.middleware.js";
import { validate } from "../../shared/middleware/validate.middleware.js";
import { cacheGetResponse } from "../../shared/middleware/cache.middleware.js";
import { updateUserValidator } from "./user.validator.js";
import {
  changePasswordController,
  deleteUserController,
  listUsersController,
  meController,
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
