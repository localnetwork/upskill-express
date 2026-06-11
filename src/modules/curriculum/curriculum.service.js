import { prisma } from "../../shared/database/prisma.js";
import { ApiError } from "../../shared/utils/ApiError.js";

async function ensureEducatorCourse(userId, courseId) {
  const course = await prisma.course.findFirst({
    where: { id: courseId, educatorId: userId, deletedAt: null },
  });
  if (!course) {
    throw new ApiError(404, "Course not found");
  }
  return course;
}

export async function createSection(userId, courseId, payload) {
  await ensureEducatorCourse(userId, courseId);
  return prisma.courseSection.create({
    data: {
      courseId,
      title: payload.title,
      description: payload.description || payload.section_description,
      position: payload.position ?? payload.sort_order ?? 0,
    },
  });
}

export async function createLesson(userId, courseId, sectionId, payload) {
  await ensureEducatorCourse(userId, courseId);
  const section = await prisma.courseSection.findFirst({
    where: { id: sectionId, courseId },
  });
  if (!section) {
    throw new ApiError(404, "Section not found");
  }

  return prisma.lesson.create({
    data: {
      sectionId,
      courseId,
      type:
        payload.type ||
        (payload.curriculum_type ? String(payload.curriculum_type).toUpperCase().replace("ARTICLE", "RESOURCE") : "RESOURCE"),
      title: payload.title,
      description: payload.description || payload.curriculum_description,
      position: payload.position ?? payload.sort_order ?? 0,
      durationInSeconds: payload.durationInSeconds ?? payload.estimated_duration ?? 0,
      isPreview:
        payload.isPreview ??
        (payload.published === undefined ? false : !(payload.published === true || payload.published === "1")),
      videoUrl: payload.videoUrl,
      resourceUrl: payload.resourceUrl,
      assignmentText: payload.assignmentText,
      codingInstructions: payload.codingInstructions,
      codingStarterCode: payload.codingStarterCode,
      quizQuestions: payload.quizQuestions,
    },
  });
}

export async function uploadLessonMedia(userId, courseId, lessonId, file, mediaType) {
  await ensureEducatorCourse(userId, courseId);
  const lesson = await prisma.lesson.findFirst({
    where: { id: lessonId, courseId },
  });
  if (!lesson) {
    throw new ApiError(404, "Lesson not found");
  }
  if (!file) {
    throw new ApiError(400, "File is required");
  }

  const media = await prisma.media.create({
    data: {
      userId,
      courseId,
      lessonId,
      storagePath: file.path,
      originalName: file.originalname,
      mimeType: file.mimetype,
      mediaType,
      sizeInBytes: file.size,
    },
  });

  if (mediaType === "VIDEO") {
    await prisma.lesson.update({
      where: { id: lessonId },
      data: { videoUrl: media.storagePath },
    });
  }

  if (mediaType === "RESOURCE") {
    await prisma.lesson.update({
      where: { id: lessonId },
      data: { resourceUrl: media.storagePath },
    });
  }

  return media;
}
