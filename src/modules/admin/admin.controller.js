import {
  approveCourse,
  getAdminPlatformSettings,
  getAdminActivityAnalytics,
  getRevenueReport,
  listAdminCourses,
  rejectCourse,
  updateAdminPlatformSettings,
} from "./admin.service.js";

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

export async function activityReportController(req, res) {
  const data = await getAdminActivityAnalytics(req.query);
  return res.json({ message: "Activity report fetched", data });
}

export async function listAdminCoursesController(req, res) {
  const data = await listAdminCourses(req.query);
  return res.json({
    message: "Admin courses fetched",
    ...data,
  });
}

export async function getPlatformSettingsController(_req, res) {
  const data = await getAdminPlatformSettings();
  return res.json({ message: "Platform settings fetched", data });
}

export async function updatePlatformSettingsController(req, res) {
  const data = await updateAdminPlatformSettings(req.body);
  return res.json({ message: "Platform settings updated", data });
}
