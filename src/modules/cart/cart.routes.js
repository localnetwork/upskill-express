import { Router } from "express";
import { authenticate } from "../../shared/middleware/auth.middleware.js";
import { authorize } from "../../shared/middleware/rbac.middleware.js";
import { validate } from "../../shared/middleware/validate.middleware.js";
import { cacheGetResponse } from "../../shared/middleware/cache.middleware.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import {
  addToCartController,
  getCartController,
  getCartCountController,
  removeFromCartController,
} from "./cart.controller.js";
import { addToCartValidator } from "./cart.validator.js";

const router = Router();

router.use(authenticate, authorize("LEARNER"));
router.get(
  "/",
  cacheGetResponse({
    prefix: "cart:detail",
    ttlSeconds: 30,
    varyByUser: true,
    tags: ["cart", "courses"],
  }),
  asyncHandler(getCartController),
);
router.get(
  "/count",
  cacheGetResponse({
    prefix: "cart:count",
    ttlSeconds: 30,
    varyByUser: true,
    tags: ["cart"],
  }),
  asyncHandler(getCartCountController),
);
router.post("/items", validate(addToCartValidator), asyncHandler(addToCartController));
router.delete("/items/:courseId", asyncHandler(removeFromCartController));
router.post("/", validate(addToCartValidator), asyncHandler(addToCartController));
router.delete("/:courseId", asyncHandler(removeFromCartController));

export default router;
