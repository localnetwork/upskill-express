import { approveCourse, getRevenueReport, rejectCourse } from "./admin.service.js";

export async function approveCourseController(req, res) {
  const data = await approveCourse(req.user.id, req.params.courseId, req.body.note);
  return res.json({ message: "Course approved", data });
}

export async function rejectCourseController(req, res) {
  const data = await rejectCourse(req.user.id, req.params.courseId, req.body.note);
  return res.json({ message: "Course rejected", data });
}

export async function revenueReportController(_req, res) {
  const data = await getRevenueReport();
  return res.json({ message: "Revenue report fetched", data });
}
