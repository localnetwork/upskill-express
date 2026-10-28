import { prisma } from "../../shared/database/prisma.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { createNotification } from "../notification/notification.service.js";
import { sendEmail } from "../../shared/mail/mailer.js";
import { buildCoursePublishedEmail } from "../../shared/mail/templates.js";
import { getPagination, toPagedResult } from "../../shared/utils/pagination.js";
import { getAdminActivityReport } from "../analytics/analytics.service.js";
import {
  getPlatformCommerceSettings,
  updatePlatformCommerceSettings,
} from "../platform-settings/platform-settings.service.js";

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
      workflowStatus: "PUBLISHED",
      isPublished: true,
      approvedById: adminId,
      approvedAt: new Date(),
      rejectedAt: null,
      rejectedReason: null,
    },
    include: {
      educator: { select: { email: true, firstName: true } },
    },
  });

  await createNotification({
    userId: updated.educatorId,
    type: "COURSE_APPROVAL",
    title: "Course approved and published",
    message: `Your course "${updated.title}" is approved and now live.`,
    metadata: { courseId: updated.id, slug: updated.slug, note: note || null },
  });

  if (updated.educator?.email) {
    const email = buildCoursePublishedEmail({
      firstName: updated.educator.firstName,
      courseTitle: updated.title,
      courseSlug: updated.slug,
      note,
    });
    await sendEmail({ to: updated.educator.email, ...email });
  }

  const { educator: _educator, ...publishedCourse } = updated;
  return publishedCourse;
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
    message: `Your course "${updated.title}" was rejected.\nReason: ${normalizedNote}`,
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

// Month-to-date vs the same elapsed window of the previous month, so early-month figures stay comparable.
export async function getOverviewTrends() {
  const now = new Date();
  const currentStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const previousStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const previousEnd = new Date(
    Math.min(
      previousStart.getTime() + (now.getTime() - currentStart.getTime()),
      currentStart.getTime(),
    ),
  );

  const windows = {
    current: { gte: currentStart, lt: now },
    previous: { gte: previousStart, lt: previousEnd },
  };

  const measure = async (period) => {
    const range = windows[period];
    const [users, courses, paidOrders, revenue, payoutRequests] = await Promise.all([
      prisma.user.count({ where: { deletedAt: null, createdAt: range } }),
      prisma.course.count({ where: { deletedAt: null, createdAt: range } }),
      prisma.order.count({ where: { status: "PAID", createdAt: range } }),
      prisma.order.aggregate({
        _sum: { totalAmount: true },
        where: { status: "PAID", createdAt: range },
      }),
      prisma.payoutRequest.count({ where: { requestedAt: range } }),
    ]);
    return {
      users,
      courses,
      paidOrders,
      revenue: Number(revenue._sum.totalAmount || 0),
      payoutRequests,
    };
  };

  const [current, previous] = await Promise.all([measure("current"), measure("previous")]);
  return { current, previous };
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

const ORDER_STATUSES = ["CREATED", "PAID", "FAILED", "REFUNDED", "CANCELLED"];

export async function listAdminOrders(query = {}) {
  const { page, limit, skip } = getPagination(query);
  const search = normalizeQueryString(query.search);
  const rawStatus = String(query.status || "").trim().toUpperCase();
  const status = ORDER_STATUSES.includes(rawStatus) ? rawStatus : undefined;

  const where = {
    status,
    OR: search
      ? [
          { id: { contains: search, mode: "insensitive" } },
          { user: { username: { contains: search, mode: "insensitive" } } },
          { user: { email: { contains: search, mode: "insensitive" } } },
          { user: { firstName: { contains: search, mode: "insensitive" } } },
          { user: { lastName: { contains: search, mode: "insensitive" } } },
          { items: { some: { course: { title: { contains: search, mode: "insensitive" } } } } },
        ]
      : undefined,
  };

  const [rows, total] = await Promise.all([
    prisma.order.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        user: {
          select: { id: true, username: true, email: true, firstName: true, lastName: true },
        },
        payment: { select: { provider: true, status: true } },
        items: { select: { id: true, course: { select: { id: true, title: true } } } },
      },
    }),
    prisma.order.count({ where }),
  ]);

  return toPagedResult(rows, total, page, limit);
}

export async function getAdminPlatformSettings() {
  return getPlatformCommerceSettings();
}

export async function updateAdminPlatformSettings(payload) {
  return updatePlatformCommerceSettings(payload);
}
