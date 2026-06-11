import { getCourseProgress, updateLessonProgress } from "./progress.service.js";

export async function updateLessonProgressController(req, res) {
  const data = await updateLessonProgress(req.user.id, req.body);
  return res.json({ message: "Lesson progress updated", data });
}

export async function getCourseProgressController(req, res) {
  const data = await getCourseProgress(req.user.id, req.params.courseId);
  return res.json({ message: "Course progress fetched", data });
}
