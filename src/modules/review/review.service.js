import { prisma } from "../../shared/database/prisma.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { getPagination, toPagedResult } from "../../shared/utils/pagination.js";
import { createNotification } from "../notification/notification.service.js";

function normalizeReviewSort(sort) {
  const normalized = String(sort || "recent").toLowerCase();
  if (normalized === "highest") {
    return [{ rating: "desc" }, { createdAt: "desc" }];
  }
  if (normalized === "lowest") {
    return [{ rating: "asc" }, { createdAt: "desc" }];
  }
  return [{ createdAt: "desc" }];
}

function mapReviewAuthor(user) {
  const fullName = `${user?.firstName || ""} ${user?.lastName || ""}`.trim();
  return {
    id: user?.id || null,
    username: user?.username || "",
    firstName: user?.firstName || "",
    lastName: user?.lastName || "",
    fullName: fullName || user?.username || "Learner",
  };
}

function isEnrollmentCompleted(enrollment) {
  return Boolean(
    enrollment?.status === "COMPLETED" ||
      enrollment?.completedAt ||
      enrollment?.courseProgress?.completedAt ||
      Number(enrollment?.courseProgress?.progressPct || 0) >= 100,
  );
}

async function canUserLikeCourseReview(userId, courseId) {
  if (!userId || !courseId) return false;
  const [enrollment, paidCourseAccess] = await Promise.all([
    prisma.enrollment.findFirst({
      where: {
        userId,
        courseId,
        status: {
          in: ["ACTIVE", "COMPLETED"],
        },
      },
      select: { id: true },
    }),
    prisma.orderItem.findFirst({
      where: {
        courseId,
        order: {
          userId,
          OR: [
            { status: "PAID" },
            { payment: { status: "CAPTURED" } },
          ],
        },
      },
      select: { id: true },
    }),
  ]);
  return Boolean(enrollment || paidCourseAccess);
}

export async function createReview(userId, payload) {
  const enrollment = await prisma.enrollment.findFirst({
    where: {
      userId,
      courseId: payload.courseId,
    },
    include: {
      course: true,
      courseProgress: {
        select: {
          progressPct: true,
          completedAt: true,
        },
      },
    },
  });

  if (!enrollment) {
    throw new ApiError(400, "You can review only enrolled courses");
  }
  if (!isEnrollmentCompleted(enrollment)) {
    throw new ApiError(400, "You can review this course only after completing it");
  }

  const existing = await prisma.review.findFirst({
    where: {
      userId,
      courseId: payload.courseId,
    },
  });
  if (existing) {
    throw new ApiError(400, "Review already exists for this course");
  }

  const review = await prisma.review.create({
    data: {
      userId,
      courseId: payload.courseId,
      enrollmentId: enrollment.id,
      rating: payload.rating,
      title: payload.title,
      comment: payload.comment,
    },
  });

  await createNotification({
    userId: enrollment.course.educatorId,
    type: "COURSE_REVIEW",
    title: "New course review",
    message: `Your course "${enrollment.course.title}" has a new review.`,
    metadata: { courseId: payload.courseId, rating: payload.rating },
  });

  return review;
}

export async function listCourseReviews(courseId, query, viewerUserId = null) {
  const { page, limit, skip } = getPagination(query);
  const orderBy = normalizeReviewSort(query.sort);
  const where = { courseId };
  const [rows, total, aggregate, groupedRatings, canLikeCourseReviews] = await Promise.all([
    prisma.review.findMany({
      where,
      skip,
      take: limit,
      include: {
        user: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
          },
        },
        reviewLikes: viewerUserId
          ? {
              where: { userId: viewerUserId },
              select: { id: true },
            }
          : false,
        _count: {
          select: {
            reviewLikes: true,
          },
        },
      },
      orderBy,
    }),
    prisma.review.count({ where }),
    prisma.review.aggregate({
      where,
      _avg: { rating: true },
    }),
    prisma.review.groupBy({
      by: ["rating"],
      where,
      _count: { rating: true },
    }),
    canUserLikeCourseReview(viewerUserId, courseId),
  ]);

  const ratingDistribution = [5, 4, 3, 2, 1].map((ratingValue) => {
    const row = groupedRatings.find((item) => item.rating === ratingValue);
    const count = Number(row?._count?.rating || 0);
    return {
      rating: ratingValue,
      count,
      percentage: total > 0 ? Number(((count / total) * 100).toFixed(2)) : 0,
    };
  });

  const mappedRows = rows.map((row) => ({
    ...row,
    likesCount: Number(row?._count?.reviewLikes || 0),
    likedByMe: Boolean(viewerUserId && Array.isArray(row.reviewLikes) && row.reviewLikes.length > 0),
    canLike: Boolean(viewerUserId && canLikeCourseReviews && row.userId !== viewerUserId),
    author: mapReviewAuthor(row.user),
  }));

  return {
    ...toPagedResult(mappedRows, total, page, limit),
    summary: {
      totalReviews: total,
      averageRating: Number(aggregate?._avg?.rating || 0),
      ratingDistribution,
    },
  };
}

export async function toggleReviewLike(userId, reviewId) {
  const review = await prisma.review.findFirst({
    where: { id: reviewId },
    select: {
      id: true,
      userId: true,
      courseId: true,
    },
  });

  if (!review) {
    throw new ApiError(404, "Review not found");
  }
  if (review.userId === userId) {
    throw new ApiError(400, "You cannot like your own review");
  }

  const canLike = await canUserLikeCourseReview(userId, review.courseId);
  if (!canLike) {
    throw new ApiError(403, "Only enrolled students of this course can like reviews");
  }

  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.reviewLike.findUnique({
      where: {
        reviewId_userId: {
          reviewId,
          userId,
        },
      },
      select: { id: true },
    });

    if (existing) {
      await tx.reviewLike.delete({
        where: {
          reviewId_userId: {
            reviewId,
            userId,
          },
        },
      });
    } else {
      await tx.reviewLike.create({
        data: {
          reviewId,
          userId,
        },
      });
    }

    const likesCount = await tx.reviewLike.count({
      where: { reviewId },
    });

    return {
      reviewId,
      liked: !existing,
      likesCount,
    };
  });

  return result;
}

export async function getReviewEligibility(userId, courseId) {
  if (!userId) {
    return {
      canReview: false,
      reason: "AUTH_REQUIRED",
      hasCompletedCourse: false,
      hasExistingReview: false,
      existingReview: null,
    };
  }

  const enrollment = await prisma.enrollment.findFirst({
    where: {
      userId,
      courseId,
    },
    include: {
      courseProgress: {
        select: {
          progressPct: true,
          completedAt: true,
        },
      },
    },
  });

  if (!enrollment) {
    return {
      canReview: false,
      reason: "NOT_ENROLLED",
      hasCompletedCourse: false,
      hasExistingReview: false,
      existingReview: null,
    };
  }

  const existingReview = await prisma.review.findFirst({
    where: { userId, courseId },
    select: {
      id: true,
      rating: true,
      title: true,
      comment: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  const hasCompletedCourse = isEnrollmentCompleted(enrollment);
  const hasExistingReview = Boolean(existingReview);

  return {
    canReview: hasCompletedCourse && !hasExistingReview,
    reason: hasExistingReview
      ? "ALREADY_REVIEWED"
      : hasCompletedCourse
        ? null
        : "COURSE_NOT_COMPLETED",
    hasCompletedCourse,
    hasExistingReview,
    existingReview,
  };
}

export async function listInstructorReviews(userId, query = {}) {
  const { page, limit, skip } = getPagination(query);
  const sort = normalizeReviewSort(query.sort);
  const search = String(query.search || query.q || "").trim();
  const normalizedRating = Number(query.rating || 0);
  const courseId = String(query.courseId || "").trim();
  const courseSlug = String(query.courseSlug || "").trim();

  const where = {
    course: {
      educatorId: userId,
      deletedAt: null,
      ...(courseId ? { id: courseId } : {}),
      ...(courseSlug ? { slug: courseSlug } : {}),
    },
    ...(Number.isInteger(normalizedRating) && normalizedRating >= 1 && normalizedRating <= 5
      ? { rating: normalizedRating }
      : {}),
    ...(search
      ? {
          OR: [
            { title: { contains: search, mode: "insensitive" } },
            { comment: { contains: search, mode: "insensitive" } },
            { user: { username: { contains: search, mode: "insensitive" } } },
            { user: { firstName: { contains: search, mode: "insensitive" } } },
            { user: { lastName: { contains: search, mode: "insensitive" } } },
            { course: { title: { contains: search, mode: "insensitive" } } },
          ],
        }
      : {}),
  };

  const [rows, total, aggregate, authoredCourses] = await Promise.all([
    prisma.review.findMany({
      where,
      skip,
      take: limit,
      include: {
        user: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
          },
        },
        course: {
          select: {
            id: true,
            slug: true,
            title: true,
          },
        },
      },
      orderBy: sort,
    }),
    prisma.review.count({ where }),
    prisma.review.aggregate({
      where: {
        course: {
          educatorId: userId,
          deletedAt: null,
        },
      },
      _avg: { rating: true },
      _count: { rating: true },
    }),
    prisma.course.findMany({
      where: {
        educatorId: userId,
        deletedAt: null,
      },
      select: {
        id: true,
        slug: true,
        title: true,
      },
      orderBy: { title: "asc" },
    }),
  ]);

  const mappedRows = rows.map((row) => ({
    ...row,
    author: mapReviewAuthor(row.user),
  }));

  return {
    ...toPagedResult(mappedRows, total, page, limit),
    filters: {
      courses: authoredCourses,
    },
    summary: {
      averageRating: Number(aggregate?._avg?.rating || 0),
      totalReviews: Number(aggregate?._count?.rating || 0),
    },
  };
}
