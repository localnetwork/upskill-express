import { Router } from "express";
import { authenticate } from "../../shared/middleware/auth.middleware.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { validate } from "../../shared/middleware/validate.middleware.js";
import {
  createDiscussionReplyController,
  createDiscussionThreadController,
  getDiscussionThreadController,
  listLessonDiscussionsController,
  toggleDiscussionVoteController,
  toggleDiscussionResolvedController,
} from "./discussion.controller.js";
import {
  createDiscussionReplyValidator,
  createDiscussionThreadValidator,
  listDiscussionsValidator,
  toggleDiscussionVoteValidator,
  toggleDiscussionResolvedValidator,
} from "./discussion.validator.js";

const router = Router();

router.get(
  "/courses/:slug/discussions",
  authenticate,
  validate(listDiscussionsValidator, "query"),
  asyncHandler(listLessonDiscussionsController),
);

router.post(
  "/courses/:slug/discussions",
  authenticate,
  validate(createDiscussionThreadValidator),
  asyncHandler(createDiscussionThreadController),
);

router.get(
  "/discussions/:threadId",
  authenticate,
  asyncHandler(getDiscussionThreadController),
);

router.post(
  "/discussions/:threadId/replies",
  authenticate,
  validate(createDiscussionReplyValidator),
  asyncHandler(createDiscussionReplyController),
);

router.put(
  "/discussions/:threadId/resolved",
  authenticate,
  validate(toggleDiscussionResolvedValidator),
  asyncHandler(toggleDiscussionResolvedController),
);

router.put(
  "/discussions/:threadId/vote",
  authenticate,
  validate(toggleDiscussionVoteValidator),
  asyncHandler(toggleDiscussionVoteController),
);

export default router;
