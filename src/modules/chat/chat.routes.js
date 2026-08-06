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
  setNicknameController,
  setBackgroundController,
  clearBackgroundController,
  conversationDetailController,
} from "./chat.controller.js";
import {
  createConversationValidator,
  listConversationsValidator,
  listMessagesValidator,
  searchUsersValidator,
  sendMessageValidator,
  deleteMessageValidator,
  nicknameValidator,
  backgroundValidator,
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

// NOTE: `GET /conversations/:conversationId` is declared AFTER
// `GET /conversations/:conversationId/messages` so the more specific
// route is matched first and there is no shadowing.
router.get(
  "/conversations/:conversationId",
  asyncHandler(conversationDetailController),
);
router.put(
  "/conversations/:conversationId/nicknames/:targetUserId",
  validate(nicknameValidator),
  asyncHandler(setNicknameController),
);
router.put(
  "/conversations/:conversationId/background",
  validate(backgroundValidator),
  asyncHandler(setBackgroundController),
);
router.delete(
  "/conversations/:conversationId/background",
  asyncHandler(clearBackgroundController),
);

export default router;
