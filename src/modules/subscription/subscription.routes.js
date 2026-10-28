import { Router } from "express";
import { z } from "zod";
import { authenticate } from "../../shared/middleware/auth.middleware.js";
import { authorize, authorizePermission } from "../../shared/middleware/rbac.middleware.js";
import { validate } from "../../shared/middleware/validate.middleware.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import {
  getAccessSummary,
  getCourseAccessOptions,
  grantCourseAccess,
} from "../access/access.service.js";
import { verifyXenditCallbackToken } from "../checkout/xendit.service.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { extendUserTrial, getTrialFunnel, startTrialIfEligible } from "../access/trial.service.js";
import {
  cancelMySubscription,
  confirmSubscription,
  reconcilePendingSubscriptions,
  createPlan,
  handleSubscriptionWebhook,
  handleXenditSubscriptionWebhook,
  listAllPlans,
  listMySubscriptions,
  listPublicPlans,
  getCatalogSummary,
  listSubscriptionsAdmin,
  subscribeToPlan,
  updatePlan,
} from "./subscription.service.js";

const router = Router();

const planBodySchema = z.object({
  name: z.string().trim().min(2).max(80),
  interval: z.enum(["MONTH", "YEAR"]),
  price: z.number().positive().max(1000000),
  firstCyclePrice: z.number().positive().max(1000000).optional(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional(),
  isActive: z.boolean().optional(),
});
const planUpdateSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  isActive: z.boolean().optional(),
});
const subscribeSchema = z.object({ planId: z.string().min(1), next: z.string().max(300).optional() });
const confirmSchema = z.object({ subscriptionId: z.string().min(1) });
const extendSchema = z.object({ days: z.number().int().min(1).max(30) });

router.post(
  "/webhook/paypal",
  asyncHandler(async (req, res) => {
    const data = await handleSubscriptionWebhook(req.body, req.headers);
    res.json({ data });
  }),
);

router.post(
  "/webhook/xendit",
  asyncHandler(async (req, res) => {
    if (!verifyXenditCallbackToken(req.headers["x-callback-token"])) {
      throw new ApiError(401, "Invalid callback token");
    }
    res.json({ data: await handleXenditSubscriptionWebhook(req.body) });
  }),
);

router.get(
  "/plans",
  asyncHandler(async (_req, res) => {
    res.json({ data: await listPublicPlans() });
  }),
);

router.get(
  "/catalog-summary",
  asyncHandler(async (_req, res) => {
    res.json({ data: await getCatalogSummary() });
  }),
);

router.get(
  "/me",
  authenticate,
  asyncHandler(async (req, res) => {
    await reconcilePendingSubscriptions(req.user.id);
    await startTrialIfEligible(req.user.id, { ipAddress: req.ip });
    res.json({ data: await getAccessSummary(req.user.id) });
  }),
);

router.get(
  "/mine",
  authenticate,
  asyncHandler(async (req, res) => {
    await reconcilePendingSubscriptions(req.user.id);
    await startTrialIfEligible(req.user.id, { ipAddress: req.ip });
    const [subscriptions, { trial }] = await Promise.all([
      listMySubscriptions(req.user.id),
      getAccessSummary(req.user.id),
    ]);
    const rows = trial.used
      ? [
          {
            id: "free-trial",
            isTrial: true,
            planName: "Free Trial",
            status: trial.active ? "TRIALING" : "EXPIRED",
            price: 0,
            currency: "PHP",
            interval: `${trial.days}-day`,
            cancelAtPeriodEnd: false,
            createdAt: trial.startedAt,
            currentPeriodStart: trial.startedAt,
            currentPeriodEnd: trial.endsAt,
          },
          ...subscriptions,
        ]
      : subscriptions;
    res.json({ data: rows });
  }),
);

router.post(
  "/subscribe",
  authenticate,
  authorize("LEARNER"),
  validate(subscribeSchema),
  asyncHandler(async (req, res) => {
    res.status(201).json({ data: await subscribeToPlan(req.user.id, req.body.planId, req.body.next) });
  }),
);
router.post(
  "/confirm",
  authenticate,
  validate(confirmSchema),
  asyncHandler(async (req, res) => {
    res.json({ data: await confirmSubscription(req.user.id, req.body.subscriptionId) });
  }),
);
router.post(
  "/cancel",
  authenticate,
  asyncHandler(async (req, res) => {
    res.json({ data: await cancelMySubscription(req.user.id) });
  }),
);

router.get(
  "/course/:courseId/access",
  authenticate,
  asyncHandler(async (req, res) => {
    res.json({ data: await getCourseAccessOptions(req.user.id, req.params.courseId) });
  }),
);
router.post(
  "/course/:courseId/access",
  authenticate,
  authorize("LEARNER"),
  asyncHandler(async (req, res) => {
    res.json({ data: await grantCourseAccess(req.user.id, req.params.courseId) });
  }),
);

router.get(
  "/admin/plans",
  authenticate,
  authorizePermission("earnings.manage"),
  asyncHandler(async (_req, res) => {
    res.json({ data: await listAllPlans() });
  }),
);
router.post(
  "/admin/plans",
  authenticate,
  authorizePermission("earnings.manage"),
  validate(planBodySchema),
  asyncHandler(async (req, res) => {
    res.status(201).json({ data: await createPlan(req.body) });
  }),
);
router.patch(
  "/admin/plans/:planId",
  authenticate,
  authorizePermission("earnings.manage"),
  validate(planUpdateSchema),
  asyncHandler(async (req, res) => {
    res.json({ data: await updatePlan(req.params.planId, req.body) });
  }),
);
router.get(
  "/admin/subscriptions",
  authenticate,
  authorizePermission("earnings.manage"),
  asyncHandler(async (req, res) => {
    res.json({ data: await listSubscriptionsAdmin(req.query) });
  }),
);

router.get(
  "/admin/trial-funnel",
  authenticate,
  authorizePermission("trial.manage", "earnings.manage"),
  asyncHandler(async (_req, res) => {
    res.json({ data: await getTrialFunnel() });
  }),
);
router.post(
  "/admin/trial/:userId/extend",
  authenticate,
  authorizePermission("trial.manage"),
  validate(extendSchema),
  asyncHandler(async (req, res) => {
    res.json({ data: await extendUserTrial(req.params.userId, req.body.days) });
  }),
);

export default router;
