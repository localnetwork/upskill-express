import { prisma } from "../../shared/database/prisma.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { getPagination, toPagedResult } from "../../shared/utils/pagination.js";
import { slugify } from "../../shared/utils/slugify.js";

async function makeUniqueSlug(title) {
  const base = slugify(title);
  const count = await prisma.course.count({
    where: { slug: { startsWith: base } },
  });
  return count > 0 ? `${base}-${count + 1}` : base;
}

export async function createCourse(userId, payload) {
  const slug = await makeUniqueSlug(payload.title);
  return prisma.course.create({
    data: {
      title: payload.title,
      subtitle: payload.subtitle,
      description: payload.description,
      slug,
      language: payload.language || "en",
      categoryId: payload.categoryId || null,
      levelId: payload.levelId || null,
      priceTierId: payload.priceTierId || null,
      educatorId: userId,
    },
  });
}

export async function updateCourse(userId, courseId, payload) {
  const course = await prisma.course.findFirst({
    where: { id: courseId, deletedAt: null },
  });

  if (!course) {
    throw new ApiError(404, "Course not found");
  }
  if (course.educatorId !== userId) {
    throw new ApiError(403, "You can only update your own course");
  }
  if (course.workflowStatus !== "DRAFT") {
    throw new ApiError(400, "Only draft courses can be updated");
  }

  return prisma.course.update({
    where: { id: courseId },
    data: payload,
  });
}

export async function deleteDraftCourse(userId, courseId) {
  const course = await prisma.course.findFirst({
    where: { id: courseId, deletedAt: null },
  });

  if (!course) {
    throw new ApiError(404, "Course not found");
  }
  if (course.educatorId !== userId) {
    throw new ApiError(403, "Forbidden");
  }
  if (course.workflowStatus !== "DRAFT") {
    throw new ApiError(400, "Only draft courses can be deleted");
  }

  await prisma.course.update({
    where: { id: courseId },
    data: { deletedAt: new Date() },
  });
  return { success: true };
}

export async function submitCourseForApproval(userId, courseId, note) {
  const course = await prisma.course.findFirst({
    where: { id: courseId, deletedAt: null },
  });
  if (!course) {
    throw new ApiError(404, "Course not found");
  }
  if (course.educatorId !== userId) {
    throw new ApiError(403, "Forbidden");
  }
  if (course.workflowStatus !== "DRAFT") {
    throw new ApiError(400, "Course is not in draft state");
  }

  return prisma.$transaction(async (tx) => {
    const updatedCourse = await tx.course.update({
      where: { id: courseId },
      data: {
        workflowStatus: "PENDING_APPROVAL",
        isDraftDeletable: false,
        submittedAt: new Date(),
      },
    });

    await tx.courseSubmission.create({
      data: {
        courseId,
        userId,
        note: note || null,
      },
    });

    return updatedCourse;
  });
}

export async function publishCourse(userId, courseId) {
  const course = await prisma.course.findFirst({
    where: { id: courseId, deletedAt: null },
  });

  if (!course) {
    throw new ApiError(404, "Course not found");
  }
  if (course.educatorId !== userId) {
    throw new ApiError(403, "Forbidden");
  }
  if (course.workflowStatus !== "APPROVED") {
    throw new ApiError(400, "Course must be approved before publishing");
  }

  return prisma.course.update({
    where: { id: courseId },
    data: {
      workflowStatus: "PUBLISHED",
      isPublished: true,
    },
  });
}

export async function listCourses(query, user) {
  const { page, limit, skip } = getPagination(query);
  const where = {
    deletedAt: null,
    workflowStatus: user?.roles?.includes("ADMIN")
      ? undefined
      : query.includePending === "true" && user?.roles?.includes("EDUCATOR")
        ? undefined
        : "PUBLISHED",
    title: query.search
      ? { contains: query.search, mode: "insensitive" }
      : undefined,
    categoryId: query.categoryId || undefined,
    levelId: query.levelId || undefined,
  };

  const [rows, total] = await Promise.all([
    prisma.course.findMany({
      where,
      skip,
      take: limit,
      include: {
        educator: { select: { id: true, email: true, username: true } },
        category: true,
        level: true,
        priceTier: true,
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.course.count({ where }),
  ]);

  return toPagedResult(rows, total, page, limit);
}

export async function getCourseBySlug(slug) {
  const course = await prisma.course.findFirst({
    where: {
      slug,
      deletedAt: null,
      workflowStatus: "PUBLISHED",
    },
    include: {
      educator: { select: { id: true, username: true } },
      category: true,
      level: true,
      priceTier: true,
      sections: {
        orderBy: { position: "asc" },
        include: {
          lessons: { orderBy: { position: "asc" } },
        },
      },
      reviews: {
        select: { rating: true },
      },
    },
  });

  if (!course) {
    throw new ApiError(404, "Course not found");
  }

  const avgRating = course.reviews.length
    ? course.reviews.reduce((acc, review) => acc + review.rating, 0) /
      course.reviews.length
    : 0;

  return {
    ...course,
    averageRating: Number(avgRating.toFixed(2)),
    reviewsCount: course.reviews.length,
  };
}
