import { prisma } from "../../shared/database/prisma.js";
import { ApiError } from "../../shared/utils/ApiError.js";

function normalizeUnlockType(value) {
  const normalized = String(value || "IMMEDIATE").trim().toUpperCase();
  if (
    normalized === "DATE" ||
    normalized === "AFTER_PREVIOUS" ||
    normalized === "AFTER_CUSTOM"
  ) {
    return normalized;
  }
  return "IMMEDIATE";
}

function evaluateLessonLockState({
  lesson,
  previousLessonId,
  completedLessonIds,
  now = new Date(),
}) {
  if (!lesson) {
    return { isLocked: true, lockReason: "Lesson not found." };
  }

  if (lesson.isPreview) {
    return {
      isLocked: false,
      lockReason: null,
      unlockType: normalizeUnlockType(lesson.unlockType),
      unlockAt: lesson.unlockAt || null,
      prerequisiteLessonId: lesson.prerequisiteLessonId || null,
    };
  }

  const unlockType = normalizeUnlockType(lesson.unlockType);
  if (unlockType === "DATE") {
    if (!lesson.unlockAt) {
      return {
        isLocked: true,
        lockReason: "This lesson is scheduled and unlock time is not set yet.",
        unlockType,
        unlockAt: null,
        prerequisiteLessonId: null,
      };
    }
    const isUnlocked = now >= new Date(lesson.unlockAt);
    return {
      isLocked: !isUnlocked,
      lockReason: isUnlocked
        ? null
        : `This lesson unlocks on ${new Date(lesson.unlockAt).toISOString()}.`,
      unlockType,
      unlockAt: lesson.unlockAt,
      prerequisiteLessonId: null,
    };
  }

  if (unlockType === "AFTER_PREVIOUS") {
    if (!previousLessonId) {
      return {
        isLocked: false,
        lockReason: null,
        unlockType,
        unlockAt: null,
        prerequisiteLessonId: null,
      };
    }
    const unlocked = completedLessonIds.has(previousLessonId);
    return {
      isLocked: !unlocked,
      lockReason: unlocked
        ? null
        : "Complete the previous lesson first to unlock this lesson.",
      unlockType,
      unlockAt: null,
      prerequisiteLessonId: previousLessonId,
    };
  }

  if (unlockType === "AFTER_CUSTOM") {
    const prerequisiteLessonId = String(lesson.prerequisiteLessonId || "").trim();
    if (!prerequisiteLessonId) {
      return {
        isLocked: true,
        lockReason: "This lesson is waiting for a prerequisite lesson setup.",
        unlockType,
        unlockAt: null,
        prerequisiteLessonId: null,
      };
    }
    const unlocked = completedLessonIds.has(prerequisiteLessonId);
    return {
      isLocked: !unlocked,
      lockReason: unlocked
        ? null
        : "Complete the required prerequisite lesson to unlock this lesson.",
      unlockType,
      unlockAt: null,
      prerequisiteLessonId,
    };
  }

  return {
    isLocked: false,
    lockReason: null,
    unlockType,
    unlockAt: null,
    prerequisiteLessonId: null,
  };
}

async function loadCourseLessonPlanWithProgress(courseId, enrollmentId) {
  const sections = await prisma.courseSection.findMany({
    where: { courseId },
    orderBy: { position: "asc" },
    select: {
      id: true,
      position: true,
      lessons: {
        orderBy: { position: "asc" },
        select: {
          id: true,
          position: true,
          isPreview: true,
          unlockType: true,
          unlockAt: true,
          prerequisiteLessonId: true,
        },
      },
    },
  });

  const progressRows = await prisma.lessonProgress.findMany({
    where: {
      enrollmentId,
      isCompleted: true,
    },
    select: {
      lessonId: true,
    },
  });

  return {
    orderedLessons: sections.flatMap((section) => section.lessons),
    completedLessonIds: new Set(progressRows.map((row) => row.lessonId)),
  };
}

export async function getLessonAccessMapForEnrollment(enrollmentId, courseId) {
  const { orderedLessons, completedLessonIds } =
    await loadCourseLessonPlanWithProgress(courseId, enrollmentId);
  const result = new Map();

  for (let index = 0; index < orderedLessons.length; index += 1) {
    const lesson = orderedLessons[index];
    const previousLessonId = orderedLessons[index - 1]?.id || null;
    const state = evaluateLessonLockState({
      lesson,
      previousLessonId,
      completedLessonIds,
    });
    result.set(lesson.id, state);
  }

  return result;
}

export async function assertLessonUnlockedForEnrollment(
  enrollmentId,
  courseId,
  lessonId,
) {
  const map = await getLessonAccessMapForEnrollment(enrollmentId, courseId);
  const state = map.get(lessonId);
  if (!state) {
    throw new ApiError(404, "Lesson not found in this course");
  }
  if (state.isLocked) {
    throw new ApiError(403, state.lockReason || "This lesson is locked.");
  }
  return state;
}

export async function assertLessonUnlockedForUser(userId, lessonId) {
  const lesson = await prisma.lesson.findUnique({
    where: { id: String(lessonId) },
    select: { id: true, courseId: true },
  });
  if (!lesson) {
    throw new ApiError(404, "Lesson not found");
  }

  const enrollment = await prisma.enrollment.findFirst({
    where: {
      userId,
      courseId: lesson.courseId,
      status: "ACTIVE",
    },
    select: { id: true },
  });
  if (!enrollment) {
    throw new ApiError(400, "You are not enrolled in this course");
  }

  return assertLessonUnlockedForEnrollment(
    enrollment.id,
    lesson.courseId,
    lesson.id,
  );
}
