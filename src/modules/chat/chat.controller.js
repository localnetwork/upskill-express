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
  setParticipantNickname,
  setConversationBackground,
  clearConversationBackground,
  getConversationDetail,
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

export async function setNicknameController(req, res) {
  const data = await setParticipantNickname(
    req.user.id,
    req.params.conversationId,
    req.params.targetUserId,
    req.body.nickname,
  );
  return res.json({ message: "Nickname updated", data });
}

export async function setBackgroundController(req, res) {
  const data = await setConversationBackground(
    req.user.id,
    req.params.conversationId,
    req.body.mediaId,
  );
  return res.json({ message: "Background updated", data });
}

export async function clearBackgroundController(req, res) {
  const data = await clearConversationBackground(
    req.user.id,
    req.params.conversationId,
  );
  return res.json({ message: "Background removed", data });
}

export async function conversationDetailController(req, res) {
  const data = await getConversationDetail(
    req.user.id,
    req.params.conversationId,
  );
  return res.json({ message: "Conversation fetched", data });
}
