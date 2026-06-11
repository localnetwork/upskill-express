import { listMyNotifications, markAsRead } from "./notification.service.js";

export async function listNotificationsController(req, res) {
  const data = await listMyNotifications(req.user.id, req.query);
  return res.json({ message: "Notifications fetched", ...data });
}

export async function markNotificationReadController(req, res) {
  await markAsRead(req.user.id, req.params.notificationId);
  return res.json({ message: "Notification marked as read" });
}
