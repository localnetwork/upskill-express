import {
  createDirectConversation,
  listConversationMessages,
  listConversations,
  getChatUnreadCount,
  markConversationRead,
  deleteMessage,
  searchChatUsers,
  sendMessage,
  uploadChatAttachment,
} from "./chat.service.js";

export async function listConversationsController(req, res) {
  const data = await listConversations(req.user.id, req.query);
  return res.json({ message: "Conversations fetched", ...data });
}

export async function createConversationController(req, res) {
  const data = await createDirectConversation(req.user.id, req.body);
  return res.status(201).json({ message: "Conversation ready", data });
}

export async function listMessagesController(req, res) {
  const data = await listConversationMessages(
    req.user.id,
    req.params.conversationId,
    req.query,
  );
  return res.json({ message: "Messages fetched", ...data });
}

export async function sendMessageController(req, res) {
  const data = await sendMessage(req.user.id, req.body);
  return res.status(201).json({ message: "Message sent", data });
}

export async function markReadController(req, res) {
  const data = await markConversationRead(req.user.id, req.params.conversationId);
  return res.json({ message: "Conversation marked as read", data });
}

export async function searchUsersController(req, res) {
  const data = await searchChatUsers(req.user.id, req.query);
  return res.json({ message: "Users fetched", data });
}

export async function uploadAttachmentController(req, res) {
  const data = await uploadChatAttachment(req.user.id, req.file);
  return res.status(201).json({ message: "Attachment uploaded", data });
}

export async function unreadCountController(req, res) {
  const data = await getChatUnreadCount(req.user.id);
  return res.json({ message: "Unread count fetched", data });
}

export async function deleteMessageController(req, res) {
  const data = await deleteMessage(
    req.user.id,
    req.params.messageId,
    req.body.mode,
  );
  return res.json({ message: "Message deleted", data });
}
