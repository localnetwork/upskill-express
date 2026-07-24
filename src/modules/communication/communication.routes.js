import { Router } from "express";
import { authenticate } from "../../shared/middleware/auth.middleware.js";
import { authorize } from "../../shared/middleware/rbac.middleware.js";
import { validate } from "../../shared/middleware/validate.middleware.js";
import { cacheGetResponse } from "../../shared/middleware/cache.middleware.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import {
  getAnnouncementDraftController,
  getInstructorAiInsightsController,
  listAnnouncementsController,
  listInstructorAssignmentsController,
  listInstructorCommunicationCoursesController,
  listInstructorMessagesController,
  listInstructorQaController,
  saveAnnouncementDraftController,
  sendAnnouncementController,
} from "./communication.controller.js";
import {
  listInstructorMessagesValidator,
  listInstructorQaValidator,
  saveAnnouncementDraftValidator,
  sendAnnouncementValidator,
} from "./communication.validator.js";

const router = Router();

router.use(authenticate, authorize("EDUCATOR"));

router.get(
  "/instructor/courses",
  cacheGetResponse({
    prefix: "communication:courses",
    ttlSeconds: 60,
    varyByUser: true,
    tags: ["communication", "courses"],
  }),
  asyncHandler(listInstructorCommunicationCoursesController),
);

router.get(
  "/instructor/qa",
  validate(listInstructorQaValidator, "query"),
  cacheGetResponse({
    prefix: "communication:qa",
    ttlSeconds: 45,
    varyByUser: true,
    tags: ["communication", "reviews", "courses"],
  }),
  asyncHandler(listInstructorQaController),
);

router.get(
  "/instructor/ai-insights",
  cacheGetResponse({
    prefix: "communication:ai-insights",
    ttlSeconds: 45,
    varyByUser: true,
    tags: ["communication", "reviews", "progress", "enrollments"],
  }),
  asyncHandler(getInstructorAiInsightsController),
);

router.get(
  "/instructor/messages",
  validate(listInstructorMessagesValidator, "query"),
  cacheGetResponse({
    prefix: "communication:messages",
    ttlSeconds: 30,
    varyByUser: true,
    tags: ["communication", "reviews", "notifications", "courses"],
  }),
  asyncHandler(listInstructorMessagesController),
);

router.get(
  "/instructor/assignments",
  cacheGetResponse({
    prefix: "communication:assignments",
    ttlSeconds: 60,
    varyByUser: true,
    tags: ["communication", "courses", "progress", "enrollments"],
  }),
  asyncHandler(listInstructorAssignmentsController),
);

router.get(
  "/instructor/announcements",
  cacheGetResponse({
    prefix: "communication:announcements:list",
    ttlSeconds: 20,
    varyByUser: true,
    tags: ["communication"],
  }),
  asyncHandler(listAnnouncementsController),
);

router.get(
  "/instructor/announcements/draft",
  cacheGetResponse({
    prefix: "communication:announcements:draft",
    ttlSeconds: 20,
    varyByUser: true,
    tags: ["communication"],
  }),
  asyncHandler(getAnnouncementDraftController),
);

router.post(
  "/instructor/announcements/draft",
  validate(saveAnnouncementDraftValidator),
  asyncHandler(saveAnnouncementDraftController),
);

router.post(
  "/instructor/announcements/send",
  validate(sendAnnouncementValidator),
  asyncHandler(sendAnnouncementController),
);

export default router;
