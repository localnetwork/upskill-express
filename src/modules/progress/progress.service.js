import { prisma } from "../../shared/database/prisma.js";
import { ApiError } from "../../shared/utils/ApiError.js";

async function getEnrollmentForLesson(userId, lessonId) {
  const lesson = await prisma.lesson.findUnique({
    where: { id: lessonId },
    select: { courseId: true },
  });
  if (!lesson) {
    throw new ApiError(404, "Lesson not found");
  }
  const enrollment = await prisma.enrollment.findFirst({
    where: {
      userId,
      courseId: lesson.courseId,
    },
  });
  if (!enrollment) {
    throw new ApiError(400, "You are not enrolled in this course");
  }
  return enrollment;
}

export async function updateLessonProgress(userId, payload) {
  const enrollment = await getEnrollmentForLesson(userId, payload.lessonId);

  await prisma.lessonProgress.upsert({
    where: {
      enrollmentId_lessonId: {
        enrollmentId: enrollment.id,
        lessonId: payload.lessonId,
      },
    },
    update: {
      progressPct: payload.progressPct,
      lastPosition: payload.lastPosition || 0,
      isCompleted: payload.isCompleted || payload.progressPct >= 100,
      completedAt:
        payload.isCompleted || payload.progressPct >= 100 ? new Date() : null,
    },
    create: {
      enrollmentId: enrollment.id,
      lessonId: payload.lessonId,
      userId,
      progressPct: payload.progressPct,
      lastPosition: payload.lastPosition || 0,
      isCompleted: payload.isCompleted || payload.progressPct >= 100,
      completedAt:
        payload.isCompleted || payload.progressPct >= 100 ? new Date() : null,
    },
  });

  const [completedLessons, totalLessons] = await Promise.all([
    prisma.lessonProgress.count({
      where: {
        enrollmentId: enrollment.id,
        isCompleted: true,
      },
    }),
    prisma.lesson.count({
      where: { courseId: enrollment.courseId },
    }),
  ]);

  const progressPct =
    totalLessons === 0 ? 0 : Number(((completedLessons / totalLessons) * 100).toFixed(2));

  await prisma.courseProgress.upsert({
    where: { enrollmentId: enrollment.id },
    update: {
      userId,
      courseId: enrollment.courseId,
      completedLessons,
      totalLessons,
      progressPct,
      completedAt: progressPct >= 100 ? new Date() : null,
    },
    create: {
      enrollmentId: enrollment.id,
      userId,
      courseId: enrollment.courseId,
      completedLessons,
      totalLessons,
      progressPct,
      completedAt: progressPct >= 100 ? new Date() : null,
    },
  });

  return prisma.courseProgress.findUnique({
    where: { enrollmentId: enrollment.id },
  });
}

export async function getCourseProgress(userId, courseId) {
  const enrollment = await prisma.enrollment.findFirst({
    where: {
      userId,
      courseId,
    },
  });
  if (!enrollment) {
    throw new ApiError(404, "Enrollment not found");
  }
  return prisma.courseProgress.findUnique({
    where: { enrollmentId: enrollment.id },
  });
}
