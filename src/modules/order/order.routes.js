import { Router } from "express";
import { authenticate } from "../../shared/middleware/auth.middleware.js";
import { authorize } from "../../shared/middleware/rbac.middleware.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { cacheGetResponse } from "../../shared/middleware/cache.middleware.js";
import { getMyOrderController, listMyOrdersController } from "./order.controller.js";

const router = Router();

router.use(authenticate, authorize("LEARNER"));
router.get(
  "/",
  cacheGetResponse({
    prefix: "orders:my",
    ttlSeconds: 60,
    varyByUser: true,
    tags: ["orders"],
  }),
  asyncHandler(listMyOrdersController),
);
router.get(
  "/:orderId",
  cacheGetResponse({
    prefix: "orders:detail",
    ttlSeconds: 60,
    varyByUser: true,
    tags: ["orders"],
  }),
  asyncHandler(getMyOrderController),
);

export default router;
