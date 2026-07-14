import { prisma } from "../../shared/database/prisma.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { createNotification } from "../notification/notification.service.js";
import { getPagination, toPagedResult } from "../../shared/utils/pagination.js";
import { getAdminActivityReport } from "../analytics/analytics.service.js";

const COURSE_COVER_MEDIA_TYPES = ["IMAGE", "COVER_IMAGE"];
const COURSE_WORKFLOW_STATUSES = new Set([
  "DRAFT",
  "PENDING_APPROVAL",
  "APPROVED",
  "PUBLISHED",
  "REJECTED",
]);

function normalizeQueryString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeAdminCourseStatus(rawStatus) {
  const status = normalizeQueryString(rawStatus).toUpperCase();
  if (!status || status === "ALL") return null;

  const aliases = {
    PENDING: "PENDING_APPROVAL",
    PENDING_REVIEW: "PENDING_APPROVAL",
    DRAFTS: "DRAFT",
    ARCHIVED: "REJECTED",
  };

  const resolvedStatus = aliases[status] || status;
  return COURSE_WORKFLOW_STATUSES.has(resolvedStatus) ? resolvedStatus : null;
}

function resolveCourseCoverImage(media = []) {
  const selectedMedia = Array.isArray(media)
    ? media.find((item) => COURSE_COVER_MEDIA_TYPES.includes(item.mediaType))
    : null;

  if (!selectedMedia) return null;

  return {
    id: selectedMedia.id,
    path: selectedMedia.storagePath,
    title: selectedMedia.originalName,
  };
}

export async function approveCourse(adminId, courseId, note) {
  const course = await prisma.course.findFirst({
    where: { id: courseId, deletedAt: null },
  });
  if (!course) {
    throw new ApiError(404, "Course not found");
  }
  if (course.educatorId === adminId) {
    throw new ApiError(400, "Educator cannot approve their own course");
  }
  if (course.workflowStatus !== "PENDING_APPROVAL") {
    throw new ApiError(400, "Course is not pending approval");
  }

  const updated = await prisma.course.update({
    where: { id: courseId },
    data: {
      workflowStatus: "APPROVED",
      approvedById: adminId,
      approvedAt: new Date(),
      rejectedAt: null,
      rejectedReason: null,
    },
  });

  await createNotification({
    userId: updated.educatorId,
    type: "COURSE_APPROVAL",
    title: "Course approved",
    message: `Your course "${updated.title}" is approved.`,
    metadata: { courseId: updated.id, note: note || null },
  });

  return updated;
}

export async function rejectCourse(adminId, courseId, note) {
  const normalizedNote = normalizeQueryString(note);
  const course = await prisma.course.findFirst({
    where: { id: courseId, deletedAt: null },
  });
  if (!course) {
    throw new ApiError(404, "Course not found");
  }
  if (course.educatorId === adminId) {
    throw new ApiError(400, "Educator cannot reject their own course");
  }
  if (course.workflowStatus !== "PENDING_APPROVAL") {
    throw new ApiError(400, "Course is not pending approval");
  }
  if (!normalizedNote) {
    throw new ApiError(400, "Rejection note is required");
  }

  const updated = await prisma.course.update({
    where: { id: courseId },
    data: {
      workflowStatus: "REJECTED",
      rejectedAt: new Date(),
      rejectedReason: normalizedNote,
    },
  });

  await createNotification({
    userId: updated.educatorId,
    type: "COURSE_APPROVAL",
    title: "Course rejected",
    message: `Your course "${updated.title}" was rejected.`,
    metadata: { courseId: updated.id, note: normalizedNote },
  });

  return updated;
}

export async function getRevenueReport() {
  const [orders, paidOrders, totals] = await Promise.all([
    prisma.order.count(),
    prisma.order.count({
      where: { status: "PAID" },
    }),
    prisma.order.aggregate({
      _sum: {
        subtotalAmount: true,
        discountAmount: true,
        taxAmount: true,
        platformFeeAmount: true,
        educatorEarnings: true,
        totalAmount: true,
      },
      where: {
        status: "PAID",
      },
    }),
  ]);

  return {
    orders,
    paidOrders,
    totals: totals._sum,
  };
}

export async function getAdminActivityAnalytics(query = {}) {
  return getAdminActivityReport(query);
}

export async function listAdminCourses(query = {}) {
  const { page, limit, skip } = getPagination(query);
  const search = normalizeQueryString(query.search);
  const status = normalizeAdminCourseStatus(query.status);

  const where = {
    deletedAt: null,
    workflowStatus: status || undefined,
    OR: search
      ? [
          { title: { contains: search, mode: "insensitive" } },
          { slug: { contains: search, mode: "insensitive" } },
          { educator: { username: { contains: search, mode: "insensitive" } } },
          { educator: { firstName: { contains: search, mode: "insensitive" } } },
          { educator: { lastName: { contains: search, mode: "insensitive" } } },
          { educator: { email: { contains: search, mode: "insensitive" } } },
          { category: { name: { contains: search, mode: "insensitive" } } },
          { category: { slug: { contains: search, mode: "insensitive" } } },
        ]
      : undefined,
  };

  const [rows, total] = await Promise.all([
    prisma.course.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        educator: {
          select: { id: true, username: true, email: true, firstName: true, lastName: true },
        },
        category: true,
        level: true,
        priceTier: true,
        media: {
          where: {
            mediaType: { in: COURSE_COVER_MEDIA_TYPES },
          },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
        _count: {
          select: {
            enrollments: true,
            reviews: true,
            sections: true,
          },
        },
      },
    }),
    prisma.course.count({ where }),
  ]);

  const courseIds = rows.map((row) => row.id);
  const ratingStats = courseIds.length
    ? await prisma.review.groupBy({
        by: ["courseId"],
        where: {
          courseId: { in: courseIds },
        },
        _avg: { rating: true },
        _count: { rating: true },
      })
    : [];

  const ratingStatsByCourseId = new Map(
    ratingStats.map((row) => [
      row.courseId,
      {
        averageRating: Number(row?._avg?.rating || 0),
        totalReviews: Number(row?._count?.rating || 0),
      },
    ]),
  );

  const mappedRows = rows.map((row) => ({
    ...row,
    coverImage: resolveCourseCoverImage(row.media),
    stats: {
      averageRating: Number(
        (ratingStatsByCourseId.get(row.id)?.averageRating || 0).toFixed(1),
      ),
      totalReviews: Number(ratingStatsByCourseId.get(row.id)?.totalReviews || 0),
      totalEnrollments: Number(row?._count?.enrollments || 0),
      totalModules: Number(row?._count?.sections || 0),
    },
  }));

  return toPagedResult(mappedRows, total, page, limit);
}
