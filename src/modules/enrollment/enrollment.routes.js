import { Router } from "express";
import { authenticate } from "../../shared/middleware/auth.middleware.js";
import { authorize } from "../../shared/middleware/rbac.middleware.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { listMyEnrollmentsController } from "./enrollment.controller.js";

const router = Router();
router.use(authenticate, authorize("LEARNER"));
router.get("/", asyncHandler(listMyEnrollmentsController));

export default router;
