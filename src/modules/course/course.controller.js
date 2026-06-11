import { z } from "zod";
import {
  createCourse,
  deleteDraftCourse,
  getCourseBySlug,
  listCourses,
  publishCourse,
  submitCourseForApproval,
  updateCourse,
} from "./course.service.js";

const submitSchema = z.object({
  note: z.string().optional(),
});

export async function createCourseController(req, res) {
  const data = await createCourse(req.user.id, req.body);
  return res.status(201).json({ message: "Course created", data });
}

export async function updateCourseController(req, res) {
  const data = await updateCourse(req.user.id, req.params.courseId, req.body);
  return res.json({ message: "Course updated", data });
}

export async function deleteDraftCourseController(req, res) {
  const data = await deleteDraftCourse(req.user.id, req.params.courseId);
  return res.json({ message: "Draft course deleted", data });
}

export async function submitCourseController(req, res) {
  const parsed = submitSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Validation failed", details: parsed.error.issues });
  }
  const data = await submitCourseForApproval(req.user.id, req.params.courseId, parsed.data.note);
  return res.json({ message: "Course submitted for approval", data });
}

export async function publishCourseController(req, res) {
  const data = await publishCourse(req.user.id, req.params.courseId);
  return res.json({ message: "Course published", data });
}

export async function listCoursesController(req, res) {
  const data = await listCourses(req.query, req.user);
  return res.json({ message: "Courses fetched", ...data });
}

export async function getCourseBySlugController(req, res) {
  const data = await getCourseBySlug(req.params.slug);
  return res.json({ message: "Course fetched", data });
}
