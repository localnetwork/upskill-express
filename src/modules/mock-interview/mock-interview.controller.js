import {
  answerMockInterview,
  finishMockInterview,
  getMockInterview,
  listMockInterviews,
  startMockInterview,
} from "./mock-interview.service.js";

export async function startMockInterviewController(req, res) {
  const data = await startMockInterview(req.user.id, req.body);
  return res.status(201).json({ message: "Mock interview started", data });
}

export async function answerMockInterviewController(req, res) {
  const data = await answerMockInterview(req.user.id, req.params.id, req.body);
  return res.json({ message: "Answer recorded", data });
}

export async function finishMockInterviewController(req, res) {
  const data = await finishMockInterview(req.user.id, req.params.id);
  return res.json({ message: "Mock interview finished", data });
}

export async function getMockInterviewController(req, res) {
  const data = await getMockInterview(req.user.id, req.params.id);
  return res.json({ message: "Mock interview fetched", data });
}

export async function listMockInterviewsController(req, res) {
  const courseId = typeof req.query.courseId === "string" ? req.query.courseId : undefined;
  const data = await listMockInterviews(req.user.id, courseId);
  return res.json({ message: "Mock interviews fetched", data });
}
