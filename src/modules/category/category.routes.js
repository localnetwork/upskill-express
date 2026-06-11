import { Router } from "express";
import { authenticate } from "../../shared/middleware/auth.middleware.js";
import { authorize } from "../../shared/middleware/rbac.middleware.js";
import { validate } from "../../shared/middleware/validate.middleware.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import {
  createCategoryController,
  deleteCategoryController,
  getCategoryController,
  listCategoriesController,
  updateCategoryController,
} from "./category.controller.js";
import { createCategoryValidator, updateCategoryValidator } from "./category.validator.js";

const router = Router();

router.get("/", asyncHandler(listCategoriesController));
router.get("/:slugOrId", asyncHandler(getCategoryController));
router.post("/", authenticate, authorize("ADMIN"), validate(createCategoryValidator), asyncHandler(createCategoryController));
router.patch("/:categoryId", authenticate, authorize("ADMIN"), validate(updateCategoryValidator), asyncHandler(updateCategoryController));
router.delete("/:categoryId", authenticate, authorize("ADMIN"), asyncHandler(deleteCategoryController));

export default router;
