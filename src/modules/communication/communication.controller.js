import {
  getAnnouncementDraft,
  getInstructorAiInsights,
  listAnnouncements,
  listInstructorAssignments,
  listInstructorCommunicationCourses,
  listInstructorMessages,
  listInstructorQa,
  saveAnnouncementDraft,
  sendAnnouncement,
} from "./communication.service.js";

export async function listInstructorCommunicationCoursesController(req, res) {
  const data = await listInstructorCommunicationCourses(req.user.id);
  return res.json({ message: "Communication courses fetched", data });
}

export async function listInstructorQaController(req, res) {
  const data = await listInstructorQa(req.user.id, req.query);
  return res.json({ message: "Q&A fetched", ...data });
}

export async function getInstructorAiInsightsController(req, res) {
  const data = await getInstructorAiInsights(req.user.id);
  return res.json({ message: "AI insights fetched", data });
}

export async function listInstructorMessagesController(req, res) {
  const data = await listInstructorMessages(req.user.id, req.query);
  return res.json({ message: "Messages fetched", ...data });
}

export async function listInstructorAssignmentsController(req, res) {
  const data = await listInstructorAssignments(req.user.id);
  return res.json({ message: "Assignments fetched", data });
}

export async function getAnnouncementDraftController(req, res) {
  const data = await getAnnouncementDraft(req.user.id);
  return res.json({ message: "Announcement draft fetched", data });
}

export async function listAnnouncementsController(req, res) {
  const data = await listAnnouncements(req.user.id, req.query);
  return res.json({ message: "Announcements fetched", ...data });
}

export async function saveAnnouncementDraftController(req, res) {
  const data = await saveAnnouncementDraft(req.user.id, req.body);
  return res.json({ message: "Announcement draft saved", data });
}

export async function sendAnnouncementController(req, res) {
  const data = await sendAnnouncement(req.user.id, req.body);
  return res.status(201).json({ message: "Announcement sent", data });
}
