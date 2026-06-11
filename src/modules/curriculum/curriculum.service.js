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
      description: payload.description,
      position: payload.position,
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
      ...payload,
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
