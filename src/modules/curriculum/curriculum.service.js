import { prisma } from "../../shared/database/prisma.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { recordActivityEvent } from "../analytics/analytics.service.js";

const supportsLessonTopics = Boolean(prisma.lessonTopic);

function lessonIncludeForTopics() {
  return supportsLessonTopics
    ? {
        topic: true,
        lessonTopics: {
          include: {
            topic: true,
          },
        },
      }
    : {
        topic: true,
      };
}

async function ensureEducatorCourse(userId, courseId) {
  const course = await prisma.course.findFirst({
    where: { id: courseId, educatorId: userId, deletedAt: null },
  });
  if (!course) {
    throw new ApiError(404, "Course not found");
  }
  return course;
}

function normalizeTopicIds(input) {
  if (input === undefined) return [];
  const rawList = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? input.split(",")
      : [input];
  const normalized = rawList
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return Array.from(new Set(normalized));
}

function extractTopicIds(payload = {}) {
  if (payload.topicIds !== undefined) return normalizeTopicIds(payload.topicIds);
  if (payload.topic_ids !== undefined) return normalizeTopicIds(payload.topic_ids);
  if (payload.topicId !== undefined) return normalizeTopicIds(payload.topicId);
  if (payload.topic_id !== undefined) return normalizeTopicIds(payload.topic_id);
  return [];
}

async function resolveCurriculumTopics(course, topicIds) {
  const normalizedTopicIds = normalizeTopicIds(topicIds);
  if (!normalizedTopicIds.length) {
    return [];
  }

  if (!course.categoryId) {
    throw new ApiError(
      400,
      "Course category is required before assigning a curriculum topic",
    );
  }

  const topics = await prisma.topic.findMany({
    where: {
      id: { in: normalizedTopicIds },
      deletedAt: null,
    },
    include: {
      category: {
        select: {
          id: true,
          parentId: true,
          deletedAt: true,
        },
      },
    },
  });

  if (topics.length !== normalizedTopicIds.length) {
    throw new ApiError(400, "One or more topics are invalid");
  }

  const topicMap = new Map(topics.map((topic) => [topic.id, topic]));

  for (const topicId of normalizedTopicIds) {
    const topic = topicMap.get(topicId);
    if (!topic || !topic.category || topic.category.deletedAt) {
      throw new ApiError(400, "One or more topics are invalid");
    }
    const belongsToCourseCategory =
      topic.categoryId === course.categoryId || topic.category.parentId === course.categoryId;
    if (!belongsToCourseCategory) {
      throw new ApiError(400, "Topic does not belong to the selected course category");
    }
  }

  return normalizedTopicIds.map((topicId) => topicMap.get(topicId));
}

export async function createSection(userId, courseId, payload) {
  await ensureEducatorCourse(userId, courseId);
  const section = await prisma.courseSection.create({
    data: {
      courseId,
      title: payload.title,
      description: payload.description || payload.section_description,
      position: payload.position ?? payload.sort_order ?? 0,
    },
  });

  await recordActivityEvent({
    eventType: "INSTRUCTOR_CURRICULUM_ADDED",
    userId,
    courseId,
    pagePath: `/instructor/courses/${courseId}/curriculum`,
    metadata: {
      entityType: "SECTION",
      entityId: section.id,
      title: section.title,
    },
  });

  return section;
}

export async function createLesson(userId, courseId, sectionId, payload) {
  const course = await ensureEducatorCourse(userId, courseId);
  const section = await prisma.courseSection.findFirst({
    where: { id: sectionId, courseId },
  });
  if (!section) {
    throw new ApiError(404, "Section not found");
  }
  const topicIds = extractTopicIds(payload);
  const topics = await resolveCurriculumTopics(course, topicIds);

  const lesson = await prisma.lesson.create({
    include: lessonIncludeForTopics(),
    data: {
      sectionId,
      courseId,
      topicId: topics[0]?.id || null,
      ...(supportsLessonTopics && topics.length > 0
        ? {
            lessonTopics: {
              create: topics.map((topic) => ({
                topicId: topic.id,
              })),
            },
          }
        : {}),
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
      codingStarterCode:
        payload.codingStarterCode === undefined
          ? undefined
          : typeof payload.codingStarterCode === "string"
            ? payload.codingStarterCode
            : JSON.stringify(payload.codingStarterCode || {}),
      quizQuestions: payload.quizQuestions,
    },
  });

  await recordActivityEvent({
    eventType: "INSTRUCTOR_CURRICULUM_ADDED",
    userId,
    courseId,
    pagePath: `/instructor/courses/${courseId}/curriculum`,
    metadata: {
      entityType: "LESSON",
      entityId: lesson.id,
      title: lesson.title,
      lessonType: lesson.type,
    },
  });

  return lesson;
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

  await recordActivityEvent({
    eventType: "INSTRUCTOR_CURRICULUM_UPDATED",
    userId,
    courseId,
    pagePath: `/instructor/courses/${courseId}/curriculum`,
    metadata: {
      entityType: "LESSON_MEDIA",
      lessonId,
      mediaType,
      mediaId: media.id,
    },
  });

  return media;
}
