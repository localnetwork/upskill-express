import { prisma } from "../../shared/database/prisma.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { getPagination, toPagedResult } from "../../shared/utils/pagination.js";
import { createNotification } from "../notification/notification.service.js";

const DISCUSSION_CATEGORY = {
  COURSE_CONTENT: "COURSE_CONTENT",
  SOMETHING_ELSE: "SOMETHING_ELSE",
};

function hasRole(actor, roleName) {
  return (actor?.roles || []).includes(roleName);
}

function normalizeDiscussionCategory(value) {
  if (value === DISCUSSION_CATEGORY.SOMETHING_ELSE) {
    return DISCUSSION_CATEGORY.SOMETHING_ELSE;
  }

  function normalizeDiscussionImagePath(value) {
    const normalized = String(value || "").trim();
    return normalized || null;
  }
  return DISCUSSION_CATEGORY.COURSE_CONTENT;
}

function normalizeListFilters(query = {}) {
  const status = String(query.status || "all").trim().toLowerCase();
  const category = String(query.category || "all").trim().toUpperCase();
  const sort = String(query.sort || "newest").trim().toLowerCase();

  return {
    status:
      status === "open" || status === "resolved" ? status : "all",
    category:
      category === DISCUSSION_CATEGORY.COURSE_CONTENT ||
      category === DISCUSSION_CATEGORY.SOMETHING_ELSE
        ? category
        : "all",
    sort:
      sort === "oldest" || sort === "most_upvoted"
        ? sort
        : "newest",
  };
}

function getThreadSortOrder(sort) {
  if (sort === "oldest") return [{ createdAt: "asc" }];
  if (sort === "most_upvoted") {
    return [{ votes: { _count: "desc" } }, { updatedAt: "desc" }];
  }
  return [{ updatedAt: "desc" }];
}

async function resolveCourseAndLesson(slug, lessonId) {
  const course = await prisma.course.findFirst({
    where: {
      OR: [{ id: String(slug || "") }, { slug: String(slug || "") }],
      deletedAt: null,
    },
    select: {
      id: true,
      slug: true,
      title: true,
      educatorId: true,
    },
  });
  if (!course) {
    throw new ApiError(404, "Course not found");
  }

  const lesson = await prisma.lesson.findFirst({
    where: {
      id: String(lessonId || ""),
      courseId: course.id,
    },
    select: {
      id: true,
      title: true,
      courseId: true,
    },
  });
  if (!lesson) {
    throw new ApiError(404, "Lesson not found for this course");
  }

  return { course, lesson };
}

async function assertCanAccessCourseLearning(actor, courseId) {
  if (hasRole(actor, "ADMIN")) return;

  const ownsCourse = await prisma.course.findFirst({
    where: { id: courseId, educatorId: actor.id, deletedAt: null },
    select: { id: true },
  });
  if (ownsCourse) return;

  const enrollment = await prisma.enrollment.findFirst({
    where: {
      userId: actor.id,
      courseId,
      status: { in: ["ACTIVE", "COMPLETED"] },
    },
    select: { id: true },
  });
  if (!enrollment) {
    throw new ApiError(403, "Not allowed to access this course discussion");
  }
}

async function canModerateDiscussion(actor, courseId) {
  if (hasRole(actor, "ADMIN")) return true;
  const ownsCourse = await prisma.course.findFirst({
    where: { id: courseId, educatorId: actor.id, deletedAt: null },
    select: { id: true },
  });
  return Boolean(ownsCourse);
}

async function assertCanModerateDiscussion(actor, courseId) {
  const allowed = await canModerateDiscussion(actor, courseId);
  if (!allowed) {
    throw new ApiError(403, "Only the course instructor can resolve discussions");
  }
}

function mapDiscussionThreadSummary(thread) {
  return {
    id: thread.id,
    courseId: thread.courseId,
    lessonId: thread.lessonId,
    category: thread.category || DISCUSSION_CATEGORY.COURSE_CONTENT,
    title: thread.title,
    body: thread.body,
    imagePath: thread.imagePath || null,
    isResolved: Boolean(thread.isResolved),
    resolvedAt: thread.resolvedAt || null,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    author: {
      id: thread.author?.id || null,
      username: thread.author?.username || "",
      firstName: thread.author?.firstName || "",
      lastName: thread.author?.lastName || "",
    },
    resolvedBy: thread.resolvedBy
      ? {
          id: thread.resolvedBy.id,
          username: thread.resolvedBy.username || "",
          firstName: thread.resolvedBy.firstName || "",
          lastName: thread.resolvedBy.lastName || "",
        }
      : null,
    upvotesCount: Number(thread?._count?.votes || 0),
    repliesCount: Number(thread?._count?.replies || 0),
    hasUpvoted: Array.isArray(thread.votes) && thread.votes.length > 0,
  };
}

function mapDiscussionReply(reply) {
  return {
    id: reply.id,
    body: reply.body,
    parentReplyId: reply.parentReplyId || null,
    createdAt: reply.createdAt,
    updatedAt: reply.updatedAt,
    author: {
      id: reply.author?.id || null,
      username: reply.author?.username || "",
      firstName: reply.author?.firstName || "",
      lastName: reply.author?.lastName || "",
    },
  };
}

function mapDiscussionThreadDetail(thread) {
  return {
    ...mapDiscussionThreadSummary(thread),
    replies: (thread.replies || []).map(mapDiscussionReply),
  };
}

export async function listLessonDiscussions(actor, slug, query = {}) {
  const lessonId = String(query.lessonId || "").trim();
  const { course, lesson } = await resolveCourseAndLesson(slug, lessonId);
  await assertCanAccessCourseLearning(actor, course.id);

  const filters = normalizeListFilters(query);
  const { page, limit, skip } = getPagination(query);

  const where = {
    courseId: course.id,
    lessonId: lesson.id,
  };
  if (filters.status === "open") where.isResolved = false;
  if (filters.status === "resolved") where.isResolved = true;
  if (filters.category !== "all") where.category = filters.category;

  const [threads, total, canModerate] = await Promise.all([
    prisma.discussionThread.findMany({
      where,
      skip,
      take: limit,
      orderBy: getThreadSortOrder(filters.sort),
      include: {
        author: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
          },
        },
        resolvedBy: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
          },
        },
        votes: {
          where: { voterId: actor.id },
          select: { id: true },
        },
        _count: {
          select: {
            replies: true,
            votes: true,
          },
        },
      },
    }),
    prisma.discussionThread.count({ where }),
    canModerateDiscussion(actor, course.id),
  ]);

  return {
    course: { id: course.id, slug: course.slug, title: course.title },
    lesson: { id: lesson.id, title: lesson.title },
    filters,
    permissions: {
      canModerate,
    },
    ...toPagedResult(threads.map(mapDiscussionThreadSummary), total, page, limit),
  };
}

export async function createDiscussionThread(actor, slug, payload = {}) {
  const { course, lesson } = await resolveCourseAndLesson(slug, payload.lessonId);
  await assertCanAccessCourseLearning(actor, course.id);

  const title = String(payload.title || "").trim();
  const body = String(payload.body || "").trim();
  const category = normalizeDiscussionCategory(payload.category);
  const imagePath = normalizeDiscussionImagePath(payload.imagePath);

  const duplicateWindow = new Date(Date.now() - 15 * 1000);
  const duplicate = await prisma.discussionThread.findFirst({
    where: {
      courseId: course.id,
      lessonId: lesson.id,
      authorId: actor.id,
      title,
      body,
      imagePath,
      createdAt: {
        gte: duplicateWindow,
      },
    },
    select: { id: true },
  });
  if (duplicate) {
    throw new ApiError(409, "Duplicate discussion detected. Please wait a moment.");
  }

  const thread = await prisma.discussionThread.create({
    data: {
      courseId: course.id,
      lessonId: lesson.id,
      authorId: actor.id,
      category,
      title,
      body,
      imagePath,
    },
    include: {
      author: {
        select: {
          id: true,
          username: true,
          firstName: true,
          lastName: true,
        },
      },
      resolvedBy: {
        select: { id: true, username: true, firstName: true, lastName: true },
      },
      votes: {
        where: { voterId: actor.id },
        select: { id: true },
      },
      _count: {
        select: {
          replies: true,
          votes: true,
        },
      },
    },
  });

  if (course.educatorId && course.educatorId !== actor.id) {
    await createNotification({
      userId: course.educatorId,
      type: "SYSTEM",
      title: "New lesson discussion thread",
      message: `${thread.author?.firstName || thread.author?.username || "A learner"} started a discussion in ${course.title}.`,
      metadata: {
        notificationKind: "DISCUSSION_THREAD_CREATED",
        threadId: thread.id,
        courseId: course.id,
        lessonId: lesson.id,
      },
    });
  }

  return mapDiscussionThreadSummary(thread);
}

export async function getDiscussionThread(actor, threadId) {
  const thread = await prisma.discussionThread.findUnique({
    where: { id: String(threadId || "") },
    include: {
      author: {
        select: {
          id: true,
          username: true,
          firstName: true,
          lastName: true,
        },
      },
      resolvedBy: {
        select: {
          id: true,
          username: true,
          firstName: true,
          lastName: true,
        },
      },
      replies: {
        orderBy: { createdAt: "asc" },
        include: {
          author: {
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
            },
          },
        },
      },
      votes: {
        where: { voterId: actor.id },
        select: { id: true },
      },
      _count: {
        select: {
          replies: true,
          votes: true,
        },
      },
    },
  });
  if (!thread) {
    throw new ApiError(404, "Discussion thread not found");
  }

  await assertCanAccessCourseLearning(actor, thread.courseId);

  return mapDiscussionThreadDetail(thread);
}

export async function createDiscussionReply(actor, threadId, payload = {}) {
  const thread = await prisma.discussionThread.findUnique({
    where: { id: String(threadId || "") },
    select: {
      id: true,
      courseId: true,
      lessonId: true,
      authorId: true,
      course: {
        select: {
          id: true,
          title: true,
          educatorId: true,
        },
      },
    },
  });
  if (!thread) {
    throw new ApiError(404, "Discussion thread not found");
  }

  await assertCanAccessCourseLearning(actor, thread.courseId);

  const parentReplyId = String(payload.parentReplyId || "").trim() || null;
  if (parentReplyId) {
    const parent = await prisma.discussionReply.findFirst({
      where: {
        id: parentReplyId,
        threadId: thread.id,
      },
      select: { id: true },
    });
    if (!parent) {
      throw new ApiError(400, "Parent reply does not belong to this thread");
    }
  }

  const reply = await prisma.discussionReply.create({
    data: {
      threadId: thread.id,
      authorId: actor.id,
      body: String(payload.body || "").trim(),
      parentReplyId,
    },
    include: {
      author: {
        select: {
          id: true,
          username: true,
          firstName: true,
          lastName: true,
        },
      },
    },
  });

  await prisma.discussionThread.update({
    where: { id: thread.id },
    data: { updatedAt: new Date() },
  });

  if (thread.authorId && thread.authorId !== actor.id) {
    await createNotification({
      userId: thread.authorId,
      type: "SYSTEM",
      title: "New reply on your discussion",
      message: `${reply.author?.firstName || reply.author?.username || "A learner"} replied to your discussion in ${thread.course.title}.`,
      metadata: {
        notificationKind: "DISCUSSION_REPLY_CREATED",
        threadId: thread.id,
        courseId: thread.courseId,
        lessonId: thread.lessonId,
      },
    });
  }

  return mapDiscussionReply(reply);
}

export async function toggleDiscussionResolved(actor, threadId, payload = {}) {
  const thread = await prisma.discussionThread.findUnique({
    where: { id: String(threadId || "") },
    select: { id: true, courseId: true },
  });
  if (!thread) {
    throw new ApiError(404, "Discussion thread not found");
  }

  await assertCanModerateDiscussion(actor, thread.courseId);

  const isResolved = Boolean(payload.isResolved);
  const updated = await prisma.discussionThread.update({
    where: { id: thread.id },
    data: {
      isResolved,
      resolvedById: isResolved ? actor.id : null,
      resolvedAt: isResolved ? new Date() : null,
    },
    include: {
      author: {
        select: {
          id: true,
          username: true,
          firstName: true,
          lastName: true,
        },
      },
      resolvedBy: {
        select: {
          id: true,
          username: true,
          firstName: true,
          lastName: true,
        },
      },
      votes: {
        where: { voterId: actor.id },
        select: { id: true },
      },
      _count: {
        select: {
          replies: true,
          votes: true,
        },
      },
      replies: {
        orderBy: { createdAt: "asc" },
        include: {
          author: {
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
            },
          },
        },
      },
    },
  });

  return mapDiscussionThreadDetail(updated);
}

export async function toggleDiscussionVote(actor, threadId, payload = {}) {
  const thread = await prisma.discussionThread.findUnique({
    where: { id: String(threadId || "") },
    select: { id: true, courseId: true },
  });
  if (!thread) {
    throw new ApiError(404, "Discussion thread not found");
  }

  await assertCanAccessCourseLearning(actor, thread.courseId);

  const isUpvoted = Boolean(payload.isUpvoted);
  if (isUpvoted) {
    await prisma.discussionThreadVote.upsert({
      where: {
        threadId_voterId: {
          threadId: thread.id,
          voterId: actor.id,
        },
      },
      create: {
        threadId: thread.id,
        voterId: actor.id,
      },
      update: {},
    });
  } else {
    await prisma.discussionThreadVote.deleteMany({
      where: {
        threadId: thread.id,
        voterId: actor.id,
      },
    });
  }

  const upvotesCount = await prisma.discussionThreadVote.count({
    where: { threadId: thread.id },
  });

  return {
    threadId: thread.id,
    hasUpvoted: isUpvoted,
    upvotesCount,
  };
}
