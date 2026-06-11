import { Router } from "express";
import { authenticate } from "../../shared/middleware/auth.middleware.js";
import { authorize } from "../../shared/middleware/rbac.middleware.js";
import { validate } from "../../shared/middleware/validate.middleware.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { addToCartController, getCartController, removeFromCartController } from "./cart.controller.js";
import { addToCartValidator } from "./cart.validator.js";

const router = Router();

router.use(authenticate, authorize("LEARNER"));
router.get("/", asyncHandler(getCartController));
router.post("/items", validate(addToCartValidator), asyncHandler(addToCartController));
router.delete("/items/:courseId", asyncHandler(removeFromCartController));

export default router;
