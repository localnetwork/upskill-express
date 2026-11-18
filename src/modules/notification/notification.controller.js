import {
  createAnnouncementComment,
  getMyNotification,
  listAnnouncementComments,
  listMyNotifications,
  markAsRead,
} from "./notification.service.js";

export async function listNotificationsController(req, res) {
  const data = await listMyNotifications(req.user.id, req.query);
  return res.json({ message: "Notifications fetched", ...data });
}

export async function markNotificationReadController(req, res) {
  await markAsRead(req.user.id, req.params.notificationId);
  return res.json({ message: "Notification marked as read" });
}

export async function getNotificationController(req, res) {
  const data = await getMyNotification(req.user.id, req.params.notificationId);
  return res.json({ message: "Notification fetched", data });
}

export async function listAnnouncementCommentsController(req, res) {
  const data = await listAnnouncementComments(
    req.user.id,
    req.params.notificationId,
    req.query,
  );
  return res.json({ message: "Comments fetched", ...data });
}

export async function createAnnouncementCommentController(req, res) {
  const data = await createAnnouncementComment(
    req.user.id,
    req.params.notificationId,
    req.body.body,
  );
  return res.status(201).json({ message: "Comment posted", data });
}
