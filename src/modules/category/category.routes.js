import { Router } from "express";
import { authenticate } from "../../shared/middleware/auth.middleware.js";
import { authorizePermission } from "../../shared/middleware/rbac.middleware.js";
import { validate } from "../../shared/middleware/validate.middleware.js";
import { cacheGetResponse } from "../../shared/middleware/cache.middleware.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import {
  createCategoryController,
  deleteCategoryController,
  getCategoryController,
  listCategoriesController,
  suggestCategoryContentController,
  updateCategoryController,
} from "./category.controller.js";
import { createCategoryValidator, updateCategoryValidator } from "./category.validator.js";

const router = Router();

router.get(
  "/",
  cacheGetResponse({
    prefix: "categories:list",
    ttlSeconds: 300,
    tags: ["categories"],
  }),
  asyncHandler(listCategoriesController),
);
router.get(
  "/:slugOrId",
  cacheGetResponse({
    prefix: "categories:detail",
    ttlSeconds: 300,
    tags: ["categories"],
  }),
  asyncHandler(getCategoryController),
);
router.post("/ai-suggest", authenticate, authorizePermission("categories.manage"), asyncHandler(suggestCategoryContentController));
router.post("/", authenticate, authorizePermission("categories.manage"), validate(createCategoryValidator), asyncHandler(createCategoryController));
router.patch("/:categoryId", authenticate, authorizePermission("categories.manage"), validate(updateCategoryValidator), asyncHandler(updateCategoryController));
router.delete("/:categoryId", authenticate, authorizePermission("categories.manage"), asyncHandler(deleteCategoryController));

export default router;
