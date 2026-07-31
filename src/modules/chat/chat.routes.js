import { Router } from "express";
import { authenticate } from "../../shared/middleware/auth.middleware.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { validate } from "../../shared/middleware/validate.middleware.js";
import { upload } from "../../shared/middleware/upload.middleware.js";
import {
  createConversationController,
  listConversationsController,
  listMessagesController,
  markReadController,
  unreadCountController,
  deleteMessageController,
  searchUsersController,
  sendMessageController,
  uploadAttachmentController,
} from "./chat.controller.js";
import {
  createConversationValidator,
  listConversationsValidator,
  listMessagesValidator,
  searchUsersValidator,
  sendMessageValidator,
  deleteMessageValidator,
} from "./chat.validator.js";

const router = Router();

router.use(authenticate);

router.get(
  "/conversations",
  validate(listConversationsValidator, "query"),
  asyncHandler(listConversationsController),
);
router.get("/unread-count", asyncHandler(unreadCountController));
router.post(
  "/conversations",
  validate(createConversationValidator),
  asyncHandler(createConversationController),
);
router.get(
  "/conversations/:conversationId/messages",
  validate(listMessagesValidator, "query"),
  asyncHandler(listMessagesController),
);
router.post(
  "/messages",
  validate(sendMessageValidator),
  asyncHandler(sendMessageController),
);
router.post(
  "/messages/:messageId/delete",
  validate(deleteMessageValidator),
  asyncHandler(deleteMessageController),
);
router.post(
  "/conversations/:conversationId/read",
  asyncHandler(markReadController),
);
router.get(
  "/users/search",
  validate(searchUsersValidator, "query"),
  asyncHandler(searchUsersController),
);
router.post(
  "/upload",
  upload.single("file"),
  asyncHandler(uploadAttachmentController),
);

export default router;
