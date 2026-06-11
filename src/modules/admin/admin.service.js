import { prisma } from "../../shared/database/prisma.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { createNotification } from "../notification/notification.service.js";

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
