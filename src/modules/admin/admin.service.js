import { prisma } from "../../shared/database/prisma.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { createNotification } from "../notification/notification.service.js";
import { getPagination, toPagedResult } from "../../shared/utils/pagination.js";
import { getAdminActivityReport } from "../analytics/analytics.service.js";

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

  const updated = await prisma.course.update({
    where: { id: courseId },
    data: {
      workflowStatus: "REJECTED",
      rejectedAt: new Date(),
      rejectedReason: note || "Rejected by admin",
    },
  });

  await createNotification({
    userId: updated.educatorId,
    type: "COURSE_APPROVAL",
    title: "Course rejected",
    message: `Your course "${updated.title}" was rejected.`,
    metadata: { courseId: updated.id, note: note || null },
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
  const where = {
    deletedAt: null,
    workflowStatus: query.status || undefined,
    title: query.search
      ? { contains: query.search, mode: "insensitive" }
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
      },
    }),
    prisma.course.count({ where }),
  ]);

  return toPagedResult(rows, total, page, limit);
}
