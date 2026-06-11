import { Router } from "express";
import { authenticate } from "../../shared/middleware/auth.middleware.js";
import { authorize } from "../../shared/middleware/rbac.middleware.js";
import { validate } from "../../shared/middleware/validate.middleware.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import {
  addToWishlistController,
  listWishlistController,
  removeFromWishlistController,
} from "./wishlist.controller.js";
import { addToWishlistValidator } from "./wishlist.validator.js";

const router = Router();

router.use(authenticate, authorize("LEARNER"));
router.get("/", asyncHandler(listWishlistController));
router.post("/", validate(addToWishlistValidator), asyncHandler(addToWishlistController));
router.delete("/:courseId", asyncHandler(removeFromWishlistController));

export default router;

