import { prisma } from "../../shared/database/prisma.js";
import { Prisma } from "@prisma/client";
import { ApiError } from "../../shared/utils/ApiError.js";
import { env } from "../../shared/config/env.js";
import { calculateTax } from "./tax.service.js";
import {
  capturePayPalOrder,
  createPayPalOrder,
  getPayPalOrder,
} from "./paypal.service.js";
import { createNotification } from "../notification/notification.service.js";
import { recordActivityEvent } from "../analytics/analytics.service.js";
import {
  emitCheckoutStatusToUser,
  emitNotificationToUser,
} from "../../shared/realtime/socket.js";

const DEFAULT_CURRENCY = "PHP";
const appBaseUrl = env.frontendUrl.replace(/\/$/, "");
const checkoutOrderInclude = {
  items: {
    include: {
      course: {
        select: {
          id: true,
          title: true,
          media: {
            where: {
              mediaType: { in: ["COVER_IMAGE", "IMAGE"] },
            },
            orderBy: { createdAt: "desc" },
            take: 1,
          },
          educator: {
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
  },
};

function decimal(value) {
  return Number(value || 0);
}

function getCaptureInfo(captureResponse) {
  const purchaseUnit = captureResponse?.purchase_units?.[0] || {};
  const capture = purchaseUnit?.payments?.captures?.[0] || null;
  return {
    captureId: capture?.id || null,
    payerEmail: captureResponse?.payer?.email_address || null,
    payerId: captureResponse?.payer?.payer_id || null,
  };
}

function getDisplayName(user) {
  const fullName = `${user?.firstName || ""} ${user?.lastName || ""}`.trim();
  return fullName || user?.username || "Instructor";
}

function extractPayPalApprovalUrl(paypalPayload) {
  const links = Array.isArray(paypalPayload?.links) ? paypalPayload.links : [];
  const approveLink = links.find(
    (link) => String(link?.rel || "").toLowerCase() === "approve",
  );
  return approveLink?.href || null;
}

function isUnpaidPayPalOrderStatus(paypalStatus) {
  return String(paypalStatus || "").toUpperCase() === "CREATED";
}

async function createEnrollmentWithWelcomeNotification(db, payload) {
  const existingEnrollment = await db.enrollment.findUnique({
    where: {
      userId_courseId: {
        userId: payload.userId,
        courseId: payload.courseId,
      },
    },
    select: { id: true },
  });

  if (existingEnrollment) {
    return existingEnrollment;
  }

  let enrollment = null;
  try {
    enrollment = await db.enrollment.create({
      data: {
        userId: payload.userId,
        courseId: payload.courseId,
        orderId: payload.orderId,
        orderItemId: payload.orderItemId,
        status: "ACTIVE",
      },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      const concurrentEnrollment = await db.enrollment.findUnique({
        where: {
          userId_courseId: {
            userId: payload.userId,
            courseId: payload.courseId,
          },
        },
        select: { id: true },
      });
      if (concurrentEnrollment) {
        return concurrentEnrollment;
      }
    }
    throw error;
  }

  const course = await db.course.findUnique({
    where: { id: payload.courseId },
    select: {
      id: true,
      educatorId: true,
      title: true,
      educator: {
        select: { firstName: true, lastName: true, username: true },
      },
    },
  });

  if (course?.educatorId) {
    await db.notification.create({
      data: {
        userId: course.educatorId,
        type: "ENROLLMENT",
        title: "New student enrollment",
        message: `A new learner enrolled in your course "${course.title}".`,
        metadata: {
          notificationKind: "COURSE_NEW_ENROLLMENT",
          courseId: course.id,
          courseTitle: course.title,
          learnerId: payload.userId,
        },
      },
    });
    emitNotificationToUser(course.educatorId, {
      type: "ENROLLMENT",
      title: "New student enrollment",
    });
  }

  return enrollment;
}

async function finalizeCompletedPayPalOrderByProviderOrderId(
  providerOrderId,
  originalError,
) {
  const paypalOrder = await getPayPalOrder(providerOrderId);
  const isCompleted = paypalOrder?.status === "COMPLETED";
  if (!isCompleted) {
    throw originalError || new ApiError(400, "PayPal order is not completed");
  }

  return finalizeCapturedPaymentByProviderOrderId(providerOrderId, paypalOrder);
}

async function finalizeCapturedPaymentByProviderOrderId(
  providerOrderId,
  captureResponse,
) {
  const { captureId, payerEmail, payerId } = getCaptureInfo(captureResponse);
  const paypalStatus = String(captureResponse?.status || "").toUpperCase();
  if (!captureId && paypalStatus !== "COMPLETED") {
    throw new ApiError(400, "Unable to capture payment");
  }

  let wasAlreadyCaptured = false;
  const result = await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({
      where: { providerOrderId },
      select: {
        id: true,
        status: true,
        providerCaptureId: true,
        orderId: true,
        order: {
          select: {
            id: true,
            userId: true,
            status: true,
            items: {
              select: {
                id: true,
                courseId: true,
              },
            },
          },
        },
      },
    });

    if (!payment) {
      throw new ApiError(404, "Payment not found");
    }

    if (payment.status === "CAPTURED") {
      wasAlreadyCaptured = true;
      return {
        orderId: payment.orderId,
        userId: payment.order.userId,
        items: payment.order.items,
      };
    }

    await tx.payment.update({
      where: { id: payment.id },
      data: {
        providerCaptureId: captureId || payment.providerCaptureId || null,
        status: "CAPTURED",
        capturedAt: new Date(),
        payerEmail,
        payerId,
        rawResponse: captureResponse,
      },
    });

    await tx.order.update({
      where: { id: payment.orderId },
      data: { status: "PAID" },
    });

    await tx.cartItem.deleteMany({
      where: {
        cart: { userId: payment.order.userId },
        courseId: {
          in: payment.order.items.map((item) => item.courseId),
        },
      },
    });

    return {
      orderId: payment.orderId,
      userId: payment.order.userId,
      items: payment.order.items,
    };
  });

  if (!wasAlreadyCaptured) {
    for (const item of result.items) {
      await createEnrollmentWithWelcomeNotification(prisma, {
        userId: result.userId,
        courseId: item.courseId,
        orderId: result.orderId,
        orderItemId: item.id,
      });
    }
  }

  const order = await prisma.order.findUnique({
    where: { id: result.orderId },
    include: checkoutOrderInclude,
  });
  if (!order) {
    throw new ApiError(404, "Order not found");
  }

  if (!wasAlreadyCaptured) {
    await createNotification({
      userId: result.userId,
      type: "ORDER",
      title: "Payment successful",
      message: `Order ${order.id} has been paid and enrollments are active.`,
      metadata: { orderId: order.id },
    });
  }

  emitCheckoutStatusToUser(result.userId, {
    providerOrderId,
    orderId: order.id,
    state: "PAID",
    paymentStatus: "CAPTURED",
    orderStatus: order.status,
    paypalStatus: captureResponse?.status || "COMPLETED",
  });

  return {
    order,
    wasAlreadyCaptured,
    paypalCapture: captureResponse,
  };
}

function resolveCheckoutState({ paymentStatus, orderStatus, paypalStatus }) {
  if (paymentStatus === "CAPTURED" || orderStatus === "PAID") return "PAID";
  if (
    paymentStatus === "FAILED" ||
    orderStatus === "FAILED" ||
    orderStatus === "CANCELLED" ||
    ["VOIDED", "CANCELLED", "EXPIRED", "DECLINED"].includes(
      String(paypalStatus || "").toUpperCase(),
    )
  ) {
    return "FAILED";
  }
  return "PENDING";
}

function canCancelCheckoutOrder({ paymentStatus, orderStatus, paypalStatus }) {
  if (paymentStatus === "CAPTURED" || orderStatus === "PAID") return false;
  const normalizedPaypalStatus = String(paypalStatus || "").toUpperCase();
  if (["APPROVED", "COMPLETED"].includes(normalizedPaypalStatus)) return false;
  return ["CREATED", "FAILED"].includes(
    String(orderStatus || "").toUpperCase(),
  );
}

async function getLatestCheckoutPayment(providerOrderId) {
  return prisma.payment.findFirst({
    where: { providerOrderId },
    include: {
      order: {
        include: checkoutOrderInclude,
      },
    },
  });
}

async function syncCreatedPayPalOrderRecord(
  providerOrderId,
  paypalOrderPayload = null,
) {
  if (!providerOrderId) return null;

  const payment = await prisma.payment.findFirst({
    where: { providerOrderId },
    include: {
      order: {
        select: {
          id: true,
          userId: true,
          status: true,
        },
      },
    },
  });
  if (!payment) return null;

  const currentRaw =
    payment.rawResponse && typeof payment.rawResponse === "object"
      ? payment.rawResponse
      : {};
  const nextRaw =
    paypalOrderPayload && typeof paypalOrderPayload === "object"
      ? { ...currentRaw, ...paypalOrderPayload }
      : currentRaw;

  await prisma.payment.update({
    where: { id: payment.id },
    data: {
      status: payment.status === "CAPTURED" ? payment.status : "CREATED",
      rawResponse: nextRaw,
    },
  });

  if (payment.order?.userId) {
    emitCheckoutStatusToUser(payment.order.userId, {
      providerOrderId,
      orderId: payment.order.id,
      state: resolveCheckoutState({
        paymentStatus: payment.status === "CAPTURED" ? "CAPTURED" : "CREATED",
        orderStatus: payment.order.status,
        paypalStatus: nextRaw?.status || "CREATED",
      }),
      paymentStatus: payment.status === "CAPTURED" ? "CAPTURED" : "CREATED",
      orderStatus: payment.order.status,
      paypalStatus: nextRaw?.status || "CREATED",
    });
  }

  return payment;
}

async function markCheckoutAsCancelledByProviderOrderId(
  providerOrderId,
  paypalOrderPayload = null,
) {
  if (!providerOrderId) return null;

  const payment = await prisma.payment.findFirst({
    where: { providerOrderId },
    include: {
      order: {
        include: {
          items: {
            select: {
              courseId: true,
            },
          },
        },
      },
    },
  });
  if (!payment) return null;
  if (payment.status === "CAPTURED" || payment.order?.status === "PAID") {
    return {
      payment,
      restoredCartItemsCount: 0,
      wasAlreadyCancelled: false,
    };
  }

  const currentRaw =
    payment.rawResponse && typeof payment.rawResponse === "object"
      ? payment.rawResponse
      : {};
  const nextRaw =
    paypalOrderPayload && typeof paypalOrderPayload === "object"
      ? { ...currentRaw, ...paypalOrderPayload }
      : currentRaw;

  const restoredCartItemsCount = await prisma.$transaction(async (tx) => {
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        status: "FAILED",
        rawResponse: nextRaw,
      },
    });

    if (payment.order?.status === "CREATED") {
      await tx.order.update({
        where: { id: payment.order.id },
        data: { status: "CANCELLED" },
      });
    }

    const courseIds = Array.isArray(payment.order?.items)
      ? payment.order.items.map((item) => item.courseId).filter(Boolean)
      : [];
    if (courseIds.length && payment.order?.userId) {
      const cart = await tx.cart.upsert({
        where: { userId: payment.order.userId },
        create: { userId: payment.order.userId },
        update: {},
      });
      const created = await tx.cartItem.createMany({
        data: Array.from(new Set(courseIds)).map((courseId) => ({
          cartId: cart.id,
          courseId,
        })),
        skipDuplicates: true,
      });
      return Number(created?.count || 0);
    }
    return 0;
  });

  if (payment.order?.userId) {
    emitCheckoutStatusToUser(payment.order.userId, {
      providerOrderId,
      orderId: payment.order.id,
      state: "FAILED",
      paymentStatus: "FAILED",
      orderStatus: "CANCELLED",
      paypalStatus: nextRaw?.status || "CANCELLED",
    });
  }

  return {
    payment,
    restoredCartItemsCount,
    wasAlreadyCancelled:
      payment.status === "FAILED" || payment.order?.status === "CANCELLED",
  };
}

export async function cancelCheckoutOrder(userId, providerOrderId) {
  const payment = await prisma.payment.findFirst({
    where: { providerOrderId },
    include: {
      order: {
        include: checkoutOrderInclude,
      },
    },
  });

  if (!payment) {
    throw new ApiError(404, "Payment not found");
  }
  if (userId && payment.order.userId !== userId) {
    throw new ApiError(404, "Payment not found");
  }
  if (payment.status === "CAPTURED" || payment.order.status === "PAID") {
    throw new ApiError(409, "Paid checkout cannot be cancelled");
  }

  let paypalPayload =
    payment.rawResponse && typeof payment.rawResponse === "object"
      ? payment.rawResponse
      : null;
  let paypalStatus = String(paypalPayload?.status || "").toUpperCase();

  try {
    const paypalOrder = await getPayPalOrder(providerOrderId);
    paypalPayload = paypalOrder;
    paypalStatus = String(paypalOrder?.status || "").toUpperCase();
  } catch (error) {
    const isInvalidProviderOrder =
      error?.response?.data?.name === "INVALID_RESOURCE_ID";
    if (isInvalidProviderOrder) {
      throw new ApiError(
        409,
        "Unable to verify PayPal order status. Cancellation is blocked to prevent cancelling a valid order.",
      );
    } else {
      throw error;
    }
  }

  if (["APPROVED", "COMPLETED"].includes(paypalStatus)) {
    throw new ApiError(409, "Approved checkout cannot be cancelled");
  }

  const normalizedCancellationStatus = [
    "VOIDED",
    "CANCELLED",
    "EXPIRED",
    "DECLINED",
  ].includes(paypalStatus)
    ? paypalStatus
    : "CANCELLED";
  const cancellationPayload =
    paypalPayload && typeof paypalPayload === "object"
      ? { ...paypalPayload, status: normalizedCancellationStatus }
      : { status: normalizedCancellationStatus };

  const cancellationResult = await markCheckoutAsCancelledByProviderOrderId(
    providerOrderId,
    cancellationPayload,
  );

  const latestPayment = await prisma.payment.findFirst({
    where: { providerOrderId },
    include: {
      order: {
        include: checkoutOrderInclude,
      },
    },
  });
  if (!latestPayment) {
    throw new ApiError(404, "Payment not found");
  }

  return {
    state: "FAILED",
    paymentStatus: latestPayment.status,
    orderStatus: latestPayment.order.status,
    paypalStatus: normalizedCancellationStatus,
    canCancelCheckout: canCancelCheckoutOrder({
      paymentStatus: latestPayment.status,
      orderStatus: latestPayment.order.status,
      paypalStatus: normalizedCancellationStatus,
    }),
    restoredCartItemsCount: Number(
      cancellationResult?.restoredCartItemsCount || 0,
    ),
    order: latestPayment.order,
  };
}

async function getPlatformFeePercent() {
  const setting = await prisma.platformSetting.findUnique({
    where: { key: "PLATFORM_FEE_PERCENT" },
  });
  return Number(setting?.value || 20);
}

async function resolveCoupon(code) {
  if (!code) return null;
  const coupon = await prisma.coupon.findFirst({
    where: {
      code,
      isActive: true,
      deletedAt: null,
      OR: [{ startsAt: null }, { startsAt: { lte: new Date() } }],
      AND: [{ OR: [{ endsAt: null }, { endsAt: { gte: new Date() } }] }],
    },
  });
  if (!coupon) {
    throw new ApiError(400, "Invalid coupon");
  }
  if (coupon.usageLimit && coupon.usedCount >= coupon.usageLimit) {
    throw new ApiError(400, "Coupon usage limit reached");
  }
  return coupon;
}

function calculateDiscount(coupon, subtotal) {
  if (!coupon) return 0;
  if (coupon.type === "PERCENTAGE") {
    const pctDiscount = (subtotal * decimal(coupon.value)) / 100;
    if (!coupon.maxDiscount) {
      return Number(pctDiscount.toFixed(2));
    }
    return Number(
      Math.min(pctDiscount, decimal(coupon.maxDiscount)).toFixed(2),
    );
  }
  return Number(Math.min(subtotal, decimal(coupon.value)).toFixed(2));
}

async function removeCoursesFromCartByUserId(tx, userId, courseIds) {
  const cart = await tx.cart.findUnique({ where: { userId } });
  if (!cart) {
    return;
  }

  await tx.cartItem.deleteMany({
    where: {
      cartId: cart.id,
      courseId: { in: courseIds },
    },
  });
}

async function resolveCheckoutItems(userId, payload) {
  const expressCourseIdentifier = payload.courseId || payload.course_id || null;

  if (expressCourseIdentifier) {
    const course = await prisma.course.findFirst({
      where: {
        AND: [
          {
            OR: [
              { id: expressCourseIdentifier },
              { slug: expressCourseIdentifier },
            ],
          },
          { OR: [{ workflowStatus: "PUBLISHED" }, { isPublished: true }] },
        ],
        deletedAt: null,
      },
      include: {
        priceTier: true,
      },
    });

    if (!course) {
      throw new ApiError(404, "Course not found");
    }

    return {
      referenceId: `course-${course.id}`,
      items: [{ courseId: course.id, course }],
    };
  }

  const cart = await prisma.cart.findUnique({
    where: { userId },
    include: {
      items: {
        include: {
          course: {
            include: {
              priceTier: true,
            },
          },
        },
      },
    },
  });

  if (!cart || cart.items.length === 0) {
    throw new ApiError(400, "Cart is empty");
  }

  return {
    referenceId: `cart-${cart.id}`,
    items: cart.items,
  };
}

async function findExistingPendingCheckout(userId, courseIds = []) {
  if (!Array.isArray(courseIds) || courseIds.length === 0) return null;

  const payment = await prisma.payment.findFirst({
    where: {
      status: "CREATED",
      order: {
        userId,
        status: "CREATED",
        items: {
          some: {
            courseId: { in: courseIds },
          },
        },
      },
    },
    include: {
      order: {
        include: {
          items: true,
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!payment) return null;

  const pendingCourseIds = payment.order.items.map((item) => item.courseId);
  const overlappingCourseIds = courseIds.filter((courseId) =>
    pendingCourseIds.includes(courseId),
  );
  if (!overlappingCourseIds.length) return null;

  let paypalPayload =
    payment.rawResponse && typeof payment.rawResponse === "object"
      ? payment.rawResponse
      : null;
  try {
    const paypalOrder = await getPayPalOrder(payment.providerOrderId);
    paypalPayload = paypalOrder;
    await syncCreatedPayPalOrderRecord(payment.providerOrderId, paypalOrder);
    const paypalStatus = String(paypalOrder?.status || "").toUpperCase();
    if (["VOIDED", "CANCELLED", "EXPIRED", "DECLINED"].includes(paypalStatus)) {
      await markCheckoutAsCancelledByProviderOrderId(
        payment.providerOrderId,
        paypalOrder,
      );
      return null;
    }
  } catch (error) {
    const isInvalidProviderOrder =
      error?.response?.data?.name === "INVALID_RESOURCE_ID";
    if (isInvalidProviderOrder) {
      await markCheckoutAsCancelledByProviderOrderId(payment.providerOrderId, {
        status: "CANCELLED",
      });
      return null;
    }
  }

  await prisma.cartItem.deleteMany({
    where: {
      cart: { userId },
      courseId: { in: overlappingCourseIds },
    },
  });

  return {
    reused: true,
    orderId: payment.orderId,
    providerOrderId: payment.providerOrderId,
    paypal: paypalPayload,
    pendingCourseIds,
    overlappingCourseIds,
  };
}

export async function createCheckoutOrder(userId, payload) {
  const checkoutContext = await resolveCheckoutItems(userId, payload);
  const checkoutItems = checkoutContext.items;
  const courseIds = checkoutItems.map((item) => item.courseId);
  const existingEnrollments = await prisma.enrollment.findMany({
    where: {
      userId,
      courseId: { in: courseIds },
    },
  });
  if (existingEnrollments.length > 0) {
    throw new ApiError(400, "Cannot buy an already enrolled course");
  }

  const existingPendingCheckout = await findExistingPendingCheckout(
    userId,
    courseIds,
  );
  if (existingPendingCheckout) {
    return {
      ...existingPendingCheckout,
      reusedCheckout: true,
      message:
        "You already have a checkout in progress for one or more selected courses.",
    };
  }

  const subtotal = checkoutItems.reduce(
    (sum, item) => sum + decimal(item.course.priceTier?.price || 0),
    0,
  );
  const coupon = await resolveCoupon(payload.couponCode);
  const discountAmount = calculateDiscount(coupon, subtotal);
  const taxableAmount = Number(
    Math.max(0, subtotal - discountAmount).toFixed(2),
  );

  const taxResult = await calculateTax({
    taxRegionCode: payload.taxRegionCode,
    taxableAmount,
  });

  const totalAmount = Number((taxableAmount + taxResult.taxAmount).toFixed(2));
  if (totalAmount <= 0) {
    const platformFeePercent = await getPlatformFeePercent();

    const result = await prisma.$transaction(async (tx) => {
      const order = await tx.order.create({
        data: {
          userId,
          couponId: coupon?.id,
          status: "PAID",
          subtotalAmount: subtotal,
          discountAmount,
          taxAmount: taxResult.taxAmount,
          totalAmount,
          currency: DEFAULT_CURRENCY,
          platformFeeAmount: 0,
          educatorEarnings: 0,
        },
      });

      let sumPlatformFee = 0;
      let sumEducatorEarnings = 0;

      for (const item of checkoutItems) {
        const unitPrice = decimal(item.course.priceTier?.price || 0);
        const proportionalTax =
          subtotal === 0
            ? 0
            : Number(((unitPrice / subtotal) * taxResult.taxAmount).toFixed(2));
        const taxableItemAmount = unitPrice;
        const itemPlatformFee = Number(
          ((taxableItemAmount * platformFeePercent) / 100).toFixed(2),
        );
        const educatorEarning = Number(
          (taxableItemAmount - itemPlatformFee).toFixed(2),
        );
        const totalLineAmount = Number(
          (taxableItemAmount + proportionalTax).toFixed(2),
        );

        sumPlatformFee += itemPlatformFee;
        sumEducatorEarnings += educatorEarning;

        const orderItem = await tx.orderItem.create({
          data: {
            orderId: order.id,
            courseId: item.courseId,
            educatorId: item.course.educatorId,
            unitPrice,
            discountAmount: 0,
            taxableAmount: taxableItemAmount,
            taxAmount: proportionalTax,
            platformFeePercent,
            platformFeeAmount: itemPlatformFee,
            educatorEarning,
            totalAmount: totalLineAmount,
          },
        });

        await createEnrollmentWithWelcomeNotification(tx, {
          userId,
          courseId: item.courseId,
          orderId: order.id,
          orderItemId: orderItem.id,
        });
      }

      await tx.order.update({
        where: { id: order.id },
        data: {
          platformFeeAmount: Number(sumPlatformFee.toFixed(2)),
          educatorEarnings: Number(sumEducatorEarnings.toFixed(2)),
        },
      });

      await tx.taxTransaction.create({
        data: {
          orderId: order.id,
          userId,
          regionId: taxResult.region?.id || null,
          taxableAmount,
          taxAmount: taxResult.taxAmount,
          totalAmount,
          currency: DEFAULT_CURRENCY,
          breakdown: taxResult.breakdown,
        },
      });

      if (coupon) {
        await tx.coupon.update({
          where: { id: coupon.id },
          data: {
            usedCount: {
              increment: 1,
            },
          },
        });
      }

      await removeCoursesFromCartByUserId(tx, userId, courseIds);

      return order;
    });

    await createNotification({
      userId,
      type: "ORDER",
      title: "Enrollment successful",
      message: `Order ${result.id} has been completed.`,
      metadata: { orderId: result.id, freeCheckout: true },
    });

    await recordActivityEvent({
      eventType: "COMMERCE_CHECKOUT_CREATED",
      userId,
      metadata: { orderId: result.id, freeCheckout: true },
      dedupeWindowSeconds: 5,
    });

    await recordActivityEvent({
      eventType: "COMMERCE_PURCHASE_COMPLETED",
      userId,
      metadata: { orderId: result.id, freeCheckout: true },
      dedupeWindowSeconds: 5,
    });

    return {
      freeCheckout: true,
      orderId: result.id,
      totals: {
        subtotal,
        discountAmount,
        taxableAmount,
        taxAmount: taxResult.taxAmount,
        totalAmount,
      },
    };
  }

  const providerOrder = await createPayPalOrder({
    amount: totalAmount,
    currency: DEFAULT_CURRENCY,
    referenceId: checkoutContext.referenceId,
    returnUrl: `${appBaseUrl}/checkout/success`,
    cancelUrl: `${appBaseUrl}/checkout/cancel`,
  });

  const platformFeePercent = await getPlatformFeePercent();

  return prisma
    .$transaction(async (tx) => {
      const order = await tx.order.create({
        data: {
          userId,
          couponId: coupon?.id,
          status: "CREATED",
          subtotalAmount: subtotal,
          discountAmount,
          taxAmount: taxResult.taxAmount,
          totalAmount,
          currency: DEFAULT_CURRENCY,
          platformFeeAmount: 0,
          educatorEarnings: 0,
        },
      });

      let sumPlatformFee = 0;
      let sumEducatorEarnings = 0;

      for (const item of checkoutItems) {
        const unitPrice = decimal(item.course.priceTier?.price || 0);
        const proportionalTax =
          subtotal === 0
            ? 0
            : Number(((unitPrice / subtotal) * taxResult.taxAmount).toFixed(2));
        const taxableItemAmount = unitPrice;
        const itemPlatformFee = Number(
          ((taxableItemAmount * platformFeePercent) / 100).toFixed(2),
        );
        const educatorEarning = Number(
          (taxableItemAmount - itemPlatformFee).toFixed(2),
        );
        const totalLineAmount = Number(
          (taxableItemAmount + proportionalTax).toFixed(2),
        );

        sumPlatformFee += itemPlatformFee;
        sumEducatorEarnings += educatorEarning;

        await tx.orderItem.create({
          data: {
            orderId: order.id,
            courseId: item.courseId,
            educatorId: item.course.educatorId,
            unitPrice,
            discountAmount: 0,
            taxableAmount: taxableItemAmount,
            taxAmount: proportionalTax,
            platformFeePercent,
            platformFeeAmount: itemPlatformFee,
            educatorEarning,
            totalAmount: totalLineAmount,
          },
        });
      }

      await tx.order.update({
        where: { id: order.id },
        data: {
          platformFeeAmount: Number(sumPlatformFee.toFixed(2)),
          educatorEarnings: Number(sumEducatorEarnings.toFixed(2)),
        },
      });

      await tx.payment.create({
        data: {
          orderId: order.id,
          provider: "PAYPAL",
          providerOrderId: providerOrder.id,
          status: "CREATED",
          rawResponse: providerOrder,
        },
      });

      await tx.taxTransaction.create({
        data: {
          orderId: order.id,
          userId,
          regionId: taxResult.region?.id || null,
          taxableAmount,
          taxAmount: taxResult.taxAmount,
          totalAmount,
          currency: DEFAULT_CURRENCY,
          breakdown: taxResult.breakdown,
        },
      });

      if (coupon) {
        await tx.coupon.update({
          where: { id: coupon.id },
          data: {
            usedCount: {
              increment: 1,
            },
          },
        });
      }

      await removeCoursesFromCartByUserId(tx, userId, courseIds);

      return {
        orderId: order.id,
        providerOrderId: providerOrder.id,
        paypal: providerOrder,
        totals: {
          subtotal,
          discountAmount,
          taxableAmount,
          taxAmount: taxResult.taxAmount,
          totalAmount,
        },
      };
    })
    .then(async (result) => {
      await recordActivityEvent({
        eventType: "COMMERCE_CHECKOUT_CREATED",
        userId,
        metadata: {
          orderId: result.orderId,
          providerOrderId: result.providerOrderId,
        },
        dedupeWindowSeconds: 5,
      });
      return result;
    });
}

export async function captureCheckoutOrder(userId, providerOrderId) {
  const payment = await prisma.payment.findUnique({
    where: { providerOrderId },
    include: {
      order: {
        include: checkoutOrderInclude,
      },
    },
  });

  if (!payment) {
    throw new ApiError(404, "Payment not found");
  }
  if (userId && payment.order.userId !== userId) {
    throw new ApiError(404, "Payment not found");
  }

  if (payment.status === "CAPTURED") {
    return {
      order: payment.order,
      wasAlreadyCaptured: true,
      paypalCapture: null,
    };
  }

  try {
    const captureResponse = await capturePayPalOrder(providerOrderId);
    const result = await finalizeCapturedPaymentByProviderOrderId(
      providerOrderId,
      captureResponse,
    );
    await recordActivityEvent({
      eventType: "COMMERCE_PURCHASE_COMPLETED",
      userId: payment.order.userId,
      metadata: { orderId: result?.order?.id, providerOrderId },
      dedupeWindowSeconds: 10,
    });
    return result;
  } catch (error) {
    const isAlreadyCaptured =
      error?.response?.data?.name === "UNPROCESSABLE_ENTITY";
    if (!isAlreadyCaptured) {
      throw error;
    }
    const result = await finalizeCompletedPayPalOrderByProviderOrderId(
      providerOrderId,
      error,
    );
    await recordActivityEvent({
      eventType: "COMMERCE_PURCHASE_COMPLETED",
      userId: payment.order.userId,
      metadata: { orderId: result?.order?.id, providerOrderId },
      dedupeWindowSeconds: 10,
    });
    return result;
  }
}

export async function getCheckoutOrderStatus(userId, providerOrderId) {
  const payment = await getLatestCheckoutPayment(providerOrderId);

  if (!payment) {
    throw new ApiError(404, "Payment not found");
  }
  if (userId && payment.order.userId !== userId) {
    throw new ApiError(404, "Payment not found");
  }

  if (payment.status === "CAPTURED" || payment.order.status === "PAID") {
    return {
      state: "PAID",
      paymentStatus: payment.status,
      orderStatus: payment.order.status,
      paypalStatus: "COMPLETED",
      approvalUrl: null,
      canCompletePayment: false,
      canCancelCheckout: false,
      order: payment.order,
      statusSource: "database",
    };
  }

  let paypalOrder = null;
  try {
    paypalOrder = await getPayPalOrder(providerOrderId);
    await syncCreatedPayPalOrderRecord(providerOrderId, paypalOrder);
  } catch (error) {
    const isInvalidProviderOrder =
      error?.response?.data?.name === "INVALID_RESOURCE_ID";
    if (isInvalidProviderOrder) {
      const fallbackState = resolveCheckoutState({
        paymentStatus: payment.status,
        orderStatus: payment.order.status,
        paypalStatus: payment.rawResponse?.status || null,
      });
      const fallbackApprovalUrl = extractPayPalApprovalUrl(payment.rawResponse);
      return {
        state: fallbackState,
        paymentStatus: payment.status,
        orderStatus: payment.order.status,
        paypalStatus: payment.rawResponse?.status || "UNKNOWN",
        approvalUrl: fallbackApprovalUrl,
        canCompletePayment: false,
        canCancelCheckout: false,
        order: payment.order,
        statusSource: "database-fallback",
      };
    }
    const rawPayload =
      payment.rawResponse && typeof payment.rawResponse === "object"
        ? payment.rawResponse
        : null;
    const rawPaypalStatus = rawPayload?.status || null;
    if (String(rawPaypalStatus || "").toUpperCase() === "COMPLETED") {
      let finalized = null;
      try {
        finalized = await finalizeCapturedPaymentByProviderOrderId(
          providerOrderId,
          rawPayload,
        );
      } catch (finalizeError) {
        if (finalizeError?.code !== "P2028") {
          throw finalizeError;
        }
        const latestPayment = await getLatestCheckoutPayment(providerOrderId);
        if (!latestPayment) {
          throw new ApiError(404, "Payment not found");
        }
        return {
          state:
            latestPayment.status === "CAPTURED" ||
            latestPayment.order.status === "PAID"
              ? "PAID"
              : "PENDING",
          paymentStatus: latestPayment.status,
          orderStatus: latestPayment.order.status,
          paypalStatus: "COMPLETED",
          approvalUrl: null,
          canCompletePayment: false,
          canCancelCheckout: false,
          order: latestPayment.order,
          statusSource: "database",
        };
      }
      return {
        state: "PAID",
        paymentStatus: "CAPTURED",
        orderStatus: finalized?.order?.status || "PAID",
        paypalStatus: "COMPLETED",
        approvalUrl: null,
        canCompletePayment: false,
        canCancelCheckout: false,
        order: finalized.order,
        wasAlreadyCaptured: finalized.wasAlreadyCaptured,
        statusSource: "database",
      };
    }
    const state = resolveCheckoutState({
      paymentStatus: payment.status,
      orderStatus: payment.order.status,
      paypalStatus: rawPaypalStatus,
    });
    const approvalUrl = extractPayPalApprovalUrl(payment.rawResponse);
    return {
      state,
      paymentStatus: payment.status,
      orderStatus: payment.order.status,
      paypalStatus: rawPaypalStatus,
      approvalUrl,
      canCompletePayment:
        state === "PENDING" &&
        isUnpaidPayPalOrderStatus(rawPaypalStatus) &&
        Boolean(approvalUrl),
      canCancelCheckout: canCancelCheckoutOrder({
        paymentStatus: payment.status,
        orderStatus: payment.order.status,
        paypalStatus: rawPaypalStatus,
      }),
      order: payment.order,
      statusSource: "database",
    };
  }

  const captureId =
    paypalOrder?.purchase_units?.[0]?.payments?.captures?.[0]?.id || null;
  const paypalStatus = String(paypalOrder?.status || "").toUpperCase();

  if (paypalStatus === "APPROVED" && !captureId) {
    let captured = null;
    try {
      captured = await captureCheckoutOrder(userId || null, providerOrderId);
    } catch (captureError) {
      if (captureError?.code !== "P2028") {
        throw captureError;
      }
      const latestPayment = await getLatestCheckoutPayment(providerOrderId);
      if (!latestPayment) {
        throw new ApiError(404, "Payment not found");
      }
      return {
        state:
          latestPayment.status === "CAPTURED" ||
          latestPayment.order.status === "PAID"
            ? "PAID"
            : "PENDING",
        paymentStatus: latestPayment.status,
        orderStatus: latestPayment.order.status,
        paypalStatus: paypalStatus || "APPROVED",
        approvalUrl: null,
        canCompletePayment: false,
        canCancelCheckout: false,
        order: latestPayment.order,
        statusSource: "database",
      };
    }
    return {
      state: "PAID",
      paymentStatus: "CAPTURED",
      orderStatus: captured?.order?.status || "PAID",
      paypalStatus: "COMPLETED",
      approvalUrl: null,
      canCompletePayment: false,
      canCancelCheckout: false,
      order: captured.order,
      wasAlreadyCaptured: captured.wasAlreadyCaptured,
      statusSource: "paypal",
    };
  }

  if (["VOIDED", "CANCELLED", "EXPIRED", "DECLINED"].includes(paypalStatus)) {
    await markCheckoutAsCancelledByProviderOrderId(
      providerOrderId,
      paypalOrder,
    );
    const latestPayment = await prisma.payment.findFirst({
      where: { providerOrderId },
      include: {
        order: {
          include: checkoutOrderInclude,
        },
      },
    });
    if (!latestPayment) {
      throw new ApiError(404, "Payment not found");
    }
    return {
      state: "FAILED",
      paymentStatus: latestPayment.status,
      orderStatus: latestPayment.order.status,
      paypalStatus,
      approvalUrl: null,
      canCompletePayment: false,
      canCancelCheckout: false,
      order: latestPayment.order,
      statusSource: "paypal",
    };
  }

  if (paypalStatus === "COMPLETED") {
    let finalized = null;
    try {
      finalized = await finalizeCapturedPaymentByProviderOrderId(
        providerOrderId,
        paypalOrder,
      );
    } catch (error) {
      if (error?.code !== "P2028") {
        throw error;
      }

      const latestPayment = await prisma.payment.findFirst({
        where: { providerOrderId },
        include: {
          order: {
            include: checkoutOrderInclude,
          },
        },
      });

      if (!latestPayment) {
        throw new ApiError(404, "Payment not found");
      }

      return {
        state:
          latestPayment.status === "CAPTURED" ||
          latestPayment.order.status === "PAID"
            ? "PAID"
            : "PENDING",
        paymentStatus: latestPayment.status,
        orderStatus: latestPayment.order.status,
        paypalStatus: "COMPLETED",
        approvalUrl: null,
        canCompletePayment: false,
        canCancelCheckout: false,
        order: latestPayment.order,
        statusSource: "database",
      };
    }
    return {
      state: "PAID",
      paymentStatus: "CAPTURED",
      orderStatus: finalized?.order?.status || "PAID",
      paypalStatus: "COMPLETED",
      approvalUrl: null,
      canCompletePayment: false,
      canCancelCheckout: false,
      order: finalized.order,
      wasAlreadyCaptured: finalized.wasAlreadyCaptured,
      statusSource: "paypal",
    };
  }

  const approvalUrl =
    extractPayPalApprovalUrl(paypalOrder) ||
    extractPayPalApprovalUrl(payment.rawResponse);
  const state = resolveCheckoutState({
    paymentStatus: payment.status,
    orderStatus: payment.order.status,
    paypalStatus: paypalOrder?.status || null,
  });

  return {
    state,
    paymentStatus: payment.status,
    orderStatus: payment.order.status,
    paypalStatus: paypalOrder?.status || null,
    approvalUrl,
    canCompletePayment:
      state === "PENDING" &&
      isUnpaidPayPalOrderStatus(paypalOrder?.status) &&
      Boolean(approvalUrl),
    canCancelCheckout: canCancelCheckoutOrder({
      paymentStatus: payment.status,
      orderStatus: payment.order.status,
      paypalStatus: paypalOrder?.status || null,
    }),
    order: payment.order,
    statusSource: "paypal",
  };
}

export async function handlePayPalWebhook(event) {
  const eventType = String(event?.event_type || "").toUpperCase();

  if (eventType === "CHECKOUT.ORDER.CREATED") {
    const providerOrderId = event.resource?.id;
    console.log(
      "Received PayPal webhook for CHECKOUT.ORDER.CREATED, providerOrderId:",
      providerOrderId,
    );
    if (providerOrderId) {
      await syncCreatedPayPalOrderRecord(providerOrderId, event.resource);
    }
  }

  if (eventType === "CHECKOUT.ORDER.APPROVED") {
    console.log(
      "Received PayPal webhook for CHECKOUT.ORDER.APPROVED, providerOrderId:",
      event.resource?.id,
    );
    const providerOrderId = event.resource?.id;
    if (providerOrderId) {
      try {
        const captureResponse = await capturePayPalOrder(providerOrderId);
        await finalizeCapturedPaymentByProviderOrderId(
          providerOrderId,
          captureResponse,
        );
      } catch (error) {
        const isAlreadyProcessed =
          error?.response?.data?.name === "UNPROCESSABLE_ENTITY";
        const isTransactionRace = error?.code === "P2028";
        if (!isAlreadyProcessed && !isTransactionRace) {
          throw error;
        }
        if (isAlreadyProcessed) {
          await finalizeCompletedPayPalOrderByProviderOrderId(
            providerOrderId,
            error,
          );
        }
      }
    }
  }

  if (eventType === "PAYMENT.CAPTURE.COMPLETED") {
    console.log(
      "Received PayPal webhook for PAYMENT.CAPTURE.COMPLETED, providerOrderId:",
      event.resource?.supplementary_data?.related_ids?.order_id,
    );
    const providerOrderId =
      event.resource?.supplementary_data?.related_ids?.order_id;
    if (providerOrderId) {
      const paymentsCapture = event.resource;
      const normalizedCaptureResponse = {
        payer: {
          email_address: paymentsCapture?.payer?.email_address || null,
          payer_id: paymentsCapture?.payer?.payer_id || null,
        },
        purchase_units: [
          {
            payments: {
              captures: [paymentsCapture],
            },
          },
        ],
      };
      await finalizeCapturedPaymentByProviderOrderId(
        providerOrderId,
        normalizedCaptureResponse,
      );
    }
  }

  if (eventType === "PAYMENT.CAPTURE.DENIED") {
    console.log(
      "Received PayPal webhook for PAYMENT.CAPTURE.DENIED, providerOrderId:",
      event.resource?.supplementary_data?.related_ids?.order_id,
    );
    const orderId = event.resource?.supplementary_data?.related_ids?.order_id;
    if (orderId) {
      await prisma.payment.updateMany({
        where: { providerOrderId: orderId },
        data: { status: "FAILED" },
      });

      const deniedPayment = await prisma.payment.findFirst({
        where: { providerOrderId: orderId },
        include: {
          order: {
            select: {
              id: true,
              userId: true,
              status: true,
            },
          },
        },
      });

      if (deniedPayment?.order?.userId) {
        console.log(
          "Emitting checkout status to user, userId:",
          deniedPayment.order.userId,
        );
        emitCheckoutStatusToUser(deniedPayment.order.userId, {
          providerOrderId: orderId,
          orderId: deniedPayment.order.id,
          state: "FAILED",
          paymentStatus: "FAILED",
          orderStatus: deniedPayment.order.status,
          paypalStatus: "DENIED",
        });
      }
    }
  }

  if (
    eventType === "CHECKOUT.ORDER.VOIDED" ||
    eventType === "CHECKOUT.ORDER.CANCELLED" ||
    eventType === "CHECKOUT.ORDER.EXPIRED" ||
    eventType === "CHECKOUT.ORDER.DECLINED"
  ) {
    console.log(
      "Received PayPal webhook for CHECKOUT.ORDER.VOIDED/CANCELLED/EXPIRED/DECLINED, providerOrderId:",
      event.resource?.id,
    );
    const providerOrderId = event.resource?.id;
    if (providerOrderId) {
      await markCheckoutAsCancelledByProviderOrderId(
        providerOrderId,
        event.resource,
      );
    }
  }

  if (eventType === "CHECKOUT.ORDER.SAVED") {
    const providerOrderId = event.resource?.id;
    if (providerOrderId) {
      await syncCreatedPayPalOrderRecord(providerOrderId, event.resource);
    }
  }

  if (eventType === "CHECKOUT.ORDER.COMPLETED") {
    console.log(
      "Received PayPal webhook for CHECKOUT.ORDER.COMPLETED, providerOrderId:",
      event.resource?.id,
    );
    const providerOrderId = event.resource?.id;
    if (providerOrderId) {
      try {
        await finalizeCapturedPaymentByProviderOrderId(
          providerOrderId,
          event.resource,
        );
      } catch (error) {
        const isAlreadyProcessed =
          error?.response?.data?.name === "UNPROCESSABLE_ENTITY";
        const isTransactionRace = error?.code === "P2028";
        if (!isAlreadyProcessed && !isTransactionRace) {
          throw error;
        }
        if (isAlreadyProcessed) {
          await finalizeCompletedPayPalOrderByProviderOrderId(
            providerOrderId,
            error,
          );
        }
      }
    }
  }

  return { accepted: true };
}
