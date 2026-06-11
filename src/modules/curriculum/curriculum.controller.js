import { createLesson, createSection, uploadLessonMedia } from "./curriculum.service.js";

export async function createSectionController(req, res) {
  const data = await createSection(req.user.id, req.params.courseId, req.body);
  return res.status(201).json({ message: "Section created", data });
}

export async function createLessonController(req, res) {
  const data = await createLesson(
    req.user.id,
    req.params.courseId,
    req.params.sectionId,
    req.body,
  );
  return res.status(201).json({ message: "Lesson created", data });
}

export async function uploadLessonVideoController(req, res) {
  const data = await uploadLessonMedia(
    req.user.id,
    req.params.courseId,
    req.params.lessonId,
    req.file,
    "VIDEO",
  );
  return res.status(201).json({ message: "Video uploaded", data });
}

export async function uploadLessonResourceController(req, res) {
  const data = await uploadLessonMedia(
    req.user.id,
    req.params.courseId,
    req.params.lessonId,
    req.file,
    "RESOURCE",
  );
  return res.status(201).json({ message: "Resource uploaded", data });
}
