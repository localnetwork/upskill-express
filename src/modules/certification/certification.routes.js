import { Router } from "express";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { authenticate } from "../../shared/middleware/auth.middleware.js";
import { authorize } from "../../shared/middleware/rbac.middleware.js";
import {
  generateCourseCertificateController,
  getCertificateBySlugController,
} from "./certification.controller.js";

const router = Router();

router.get("/:slug", asyncHandler(getCertificateBySlugController));
router.post(
  "/courses/:courseSlug/generate",
  authenticate,
  authorize("LEARNER"),
  asyncHandler(generateCourseCertificateController),
);

export default router;
