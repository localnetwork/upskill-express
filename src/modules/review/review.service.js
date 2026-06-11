import { prisma } from "../../shared/database/prisma.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { getPagination, toPagedResult } from "../../shared/utils/pagination.js";
import { createNotification } from "../notification/notification.service.js";

export async function createReview(userId, payload) {
  const enrollment = await prisma.enrollment.findFirst({
    where: {
      userId,
      courseId: payload.courseId,
    },
    include: {
      course: true,
    },
  });

  if (!enrollment) {
    throw new ApiError(400, "You can review only enrolled courses");
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

export async function listCourseReviews(courseId, query) {
  const { page, limit, skip } = getPagination(query);
  const where = { courseId };
  const [rows, total] = await Promise.all([
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
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.review.count({ where }),
  ]);
  return toPagedResult(rows, total, page, limit);
}
