import { Router } from "express";
import { authenticate } from "../../shared/middleware/auth.middleware.js";
import { authorizePermission } from "../../shared/middleware/rbac.middleware.js";
import { validate } from "../../shared/middleware/validate.middleware.js";
import { cacheGetResponse } from "../../shared/middleware/cache.middleware.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import {
  createTagController,
  deleteTagController,
  getTagController,
  listTagsController,
  updateTagController,
} from "./tag.controller.js";
import { createTagValidator, updateTagValidator } from "./tag.validator.js";

const router = Router();

router.get(
  "/",
  cacheGetResponse({
    prefix: "tags:list",
    ttlSeconds: 300,
    tags: ["tags", "courses"],
  }),
  asyncHandler(listTagsController),
);
router.get(
  "/:slugOrId",
  cacheGetResponse({
    prefix: "tags:detail",
    ttlSeconds: 300,
    tags: ["tags", "courses"],
  }),
  asyncHandler(getTagController),
);
router.post("/", authenticate, authorizePermission("tags.manage"), validate(createTagValidator), asyncHandler(createTagController));
router.patch("/:tagId", authenticate, authorizePermission("tags.manage"), validate(updateTagValidator), asyncHandler(updateTagController));
router.delete("/:tagId", authenticate, authorizePermission("tags.manage"), asyncHandler(deleteTagController));

export default router;
