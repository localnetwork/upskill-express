import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../shared/middleware/auth.middleware.js";
import { authorize, authorizePermission } from "../../shared/middleware/rbac.middleware.js";
import { validate } from "../../shared/middleware/validate.middleware.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import {
  calculateEarningsCycle,
  getEarningsCycleDetail,
  getEducatorEarningsSummary,
  listEarningsCycles,
  publishEarningsCycle,
  recordWatchHeartbeat,
  setCourseProgramOptIn,
} from "./earnings.service.js";

const router = Router();

const heartbeatSchema = z.object({ lessonId: z.string().min(1) });
const optInSchema = z
  .object({
    trialEligible: z.boolean().optional(),
    subscriptionEligible: z.boolean().optional(),
  })
  .refine((v) => v.trialEligible !== undefined || v.subscriptionEligible !== undefined, {
    message: "Provide trialEligible or subscriptionEligible",
  });

router.post(
  "/watch/heartbeat",
  authenticate,
  validate(heartbeatSchema),
  asyncHandler(async (req, res) => {
    res.json({ data: await recordWatchHeartbeat(req.user.id, req.body.lessonId) });
  }),
);

router.get(
  "/my",
  authenticate,
  authorize("EDUCATOR"),
  asyncHandler(async (req, res) => {
    res.json({ data: await getEducatorEarningsSummary(req.user.id) });
  }),
);
router.patch(
  "/courses/:courseId/programs",
  authenticate,
  authorize("EDUCATOR"),
  validate(optInSchema),
  asyncHandler(async (req, res) => {
    res.json({
      data: await setCourseProgramOptIn(req.user.id, req.params.courseId, req.body),
    });
  }),
);

router.get(
  "/admin/cycles",
  authenticate,
  authorizePermission("earnings.manage"),
  asyncHandler(async (req, res) => {
    res.json(await listEarningsCycles(req.query));
  }),
);
router.get(
  "/admin/cycles/:month",
  authenticate,
  authorizePermission("earnings.manage"),
  asyncHandler(async (req, res) => {
    res.json({ data: await getEarningsCycleDetail(req.params.month) });
  }),
);
router.post(
  "/admin/cycles/:month/calculate",
  authenticate,
  authorizePermission("earnings.manage"),
  asyncHandler(async (req, res) => {
    res.json({ data: await calculateEarningsCycle(req.params.month) });
  }),
);
router.post(
  "/admin/cycles/:month/publish",
  authenticate,
  authorizePermission("earnings.manage"),
  asyncHandler(async (req, res) => {
    res.json({ data: await publishEarningsCycle(req.params.month, req.user.id) });
  }),
);

export default router;
