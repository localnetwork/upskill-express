import { prisma } from "../../shared/database/prisma.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { createNotification } from "../notification/notification.service.js";

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
    include: {
      course: {
        select: {
          id: true,
          title: true,
          welcomeMessage: true,
          congratulationsMessage: true,
          educator: {
            select: { firstName: true, lastName: true, username: true },
          },
        },
      },
    },
  });
  if (!enrollment) {
    throw new ApiError(400, "You are not enrolled in this course");
  }
  return enrollment;
}

export async function updateLessonProgress(userId, payload) {
  const enrollment = await getEnrollmentForLesson(userId, payload.lessonId);
  const existingLessonProgressCount = await prisma.lessonProgress.count({
    where: { enrollmentId: enrollment.id },
  });
  const previousCourseProgress = await prisma.courseProgress.findUnique({
    where: { enrollmentId: enrollment.id },
    select: {
      progressPct: true,
      completedAt: true,
    },
  });

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

  const wasCompleted =
    Number(previousCourseProgress?.progressPct || 0) >= 100 ||
    Boolean(previousCourseProgress?.completedAt);
  const isNowCompleted = progressPct >= 100;
  const isFirstProgressUpdate = existingLessonProgressCount === 0;

  const instructorName =
    `${enrollment.course.educator?.firstName || ""} ${enrollment.course.educator?.lastName || ""}`.trim() ||
    enrollment.course.educator?.username ||
    "Instructor";
  const defaultWelcomeMessage = `Welcome to "${enrollment.course.title}"! We're excited to have you in this course.`;
  const defaultCongratulationsMessage = `Congratulations on completing "${enrollment.course.title}"! Great work finishing the course.`;

  if (isFirstProgressUpdate) {
    const existingWelcomeNotification = await prisma.notification.findFirst({
      where: {
        userId,
        type: "ENROLLMENT",
        AND: [
          {
            metadata: {
              path: ["notificationKind"],
              equals: "COURSE_WELCOME_MESSAGE",
            },
          },
          {
            metadata: {
              path: ["courseId"],
              equals: enrollment.course.id,
            },
          },
        ],
      },
      select: { id: true },
    });

    if (!existingWelcomeNotification) {
      const welcomeMessage =
        String(enrollment.course?.welcomeMessage || "").trim() ||
        defaultWelcomeMessage;
      await createNotification({
        userId,
        type: "ENROLLMENT",
        title: `Welcome message from ${instructorName}`,
        message: welcomeMessage,
        metadata: {
          notificationKind: "COURSE_WELCOME_MESSAGE",
          courseId: enrollment.course.id,
          courseTitle: enrollment.course.title,
          instructorName,
        },
      });
    }
  }

  if (!wasCompleted && isNowCompleted) {
    const congratulationsMessage =
      String(enrollment.course?.congratulationsMessage || "").trim() ||
      defaultCongratulationsMessage;

    await createNotification({
      userId,
      type: "ENROLLMENT",
      title: `Congratulations message from ${instructorName}`,
      message: congratulationsMessage,
      metadata: {
        notificationKind: "COURSE_CONGRATULATIONS_MESSAGE",
        courseId: enrollment.course.id,
        courseTitle: enrollment.course.title,
        instructorName,
      },
    });
  }

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
