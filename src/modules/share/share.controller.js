import {
  createOrGetCourseShareLink,
  resolveCourseShareLink,
} from "./share.service.js";

export async function createOrGetCourseShareLinkController(req, res) {
  const data = await createOrGetCourseShareLink(req.params.slug);
  return res.status(201).json({
    message: "Course share link ready",
    data,
  });
}

export async function resolveCourseShareLinkController(req, res) {
  const data = await resolveCourseShareLink(req.params.code);
  return res.json({
    message: "Share link resolved",
    data,
  });
}
