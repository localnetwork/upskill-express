import { prisma } from "../../shared/database/prisma.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { env } from "../../shared/config/env.js";
import { calculateTax } from "./tax.service.js";
import { capturePayPalOrder, createPayPalOrder, getPayPalOrder } from "./paypal.service.js";
import { createNotification } from "../notification/notification.service.js";

const DEFAULT_CURRENCY = "PHP";
const appBaseUrl = env.frontendUrl.replace(/\/$/, "");

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

async function finalizeCompletedPayPalOrderByProviderOrderId(providerOrderId, originalError) {
  const paypalOrder = await getPayPalOrder(providerOrderId);
  const isCompleted = paypalOrder?.status === "COMPLETED";
  const captureId = paypalOrder?.purchase_units?.[0]?.payments?.captures?.[0]?.id;
  if (!isCompleted || !captureId) {
    throw originalError;
  }

  return finalizeCapturedPaymentByProviderOrderId(providerOrderId, paypalOrder);
}

async function finalizeCapturedPaymentByProviderOrderId(providerOrderId, captureResponse) {
  const { captureId, payerEmail, payerId } = getCaptureInfo(captureResponse);
  if (!captureId) {
    throw new ApiError(400, "Unable to capture payment");
  }

  let wasAlreadyCaptured = false;
  const result = await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({
      where: { providerOrderId },
      include: {
        order: {
          include: {
            items: true,
          },
        },
      },
    });

    if (!payment) {
      throw new ApiError(404, "Payment not found");
    }

    if (payment.status === "CAPTURED") {
      wasAlreadyCaptured = true;
      const existingOrder = await tx.order.findUnique({
        where: { id: payment.orderId },
        include: { items: true },
      });
      return { payment, order: existingOrder };
    }

    await tx.payment.update({
      where: { id: payment.id },
      data: {
        providerCaptureId: captureId,
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

    for (const item of payment.order.items) {
      await tx.enrollment.upsert({
        where: {
          userId_courseId: {
            userId: payment.order.userId,
            courseId: item.courseId,
          },
        },
        update: {},
        create: {
          userId: payment.order.userId,
          courseId: item.courseId,
          orderId: payment.orderId,
          orderItemId: item.id,
          status: "ACTIVE",
        },
      });
    }

    const cart = await tx.cart.findUnique({ where: { userId: payment.order.userId } });
    if (cart) {
      await tx.cartItem.deleteMany({
        where: {
          cartId: cart.id,
          courseId: {
            in: payment.order.items.map((item) => item.courseId),
          },
        },
      });
    }

    const order = await tx.order.findUnique({
      where: { id: payment.orderId },
      include: { items: true },
    });

    return { payment, order };
  });

  if (!wasAlreadyCaptured) {
    await createNotification({
      userId: result.payment.order.userId,
      type: "ORDER",
      title: "Payment successful",
      message: `Order ${result.order.id} has been paid and enrollments are active.`,
      metadata: { orderId: result.order.id },
    });
  }

  return {
    order: result.order,
    wasAlreadyCaptured,
    paypalCapture: captureResponse,
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
    return Number(Math.min(pctDiscount, decimal(coupon.maxDiscount)).toFixed(2));
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
          { OR: [{ id: expressCourseIdentifier }, { slug: expressCourseIdentifier }] },
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

  const subtotal = checkoutItems.reduce(
    (sum, item) => sum + decimal(item.course.priceTier?.price || 0),
    0,
  );
  const coupon = await resolveCoupon(payload.couponCode);
  const discountAmount = calculateDiscount(coupon, subtotal);
  const taxableAmount = Number(Math.max(0, subtotal - discountAmount).toFixed(2));

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

        await tx.enrollment.upsert({
          where: {
            userId_courseId: {
              userId,
              courseId: item.courseId,
            },
          },
          update: {},
          create: {
            userId,
            courseId: item.courseId,
            orderId: order.id,
            orderItemId: orderItem.id,
            status: "ACTIVE",
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

  return prisma.$transaction(async (tx) => {
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
        subtotal === 0 ? 0 : Number(((unitPrice / subtotal) * taxResult.taxAmount).toFixed(2));
      const taxableItemAmount = unitPrice;
      const itemPlatformFee = Number(
        ((taxableItemAmount * platformFeePercent) / 100).toFixed(2),
      );
      const educatorEarning = Number((taxableItemAmount - itemPlatformFee).toFixed(2));
      const totalLineAmount = Number((taxableItemAmount + proportionalTax).toFixed(2));

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
  });
}

export async function captureCheckoutOrder(userId, providerOrderId) {
  const payment = await prisma.payment.findUnique({
    where: { providerOrderId },
    include: {
      order: {
        include: {
          items: true,
        },
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
    return finalizeCapturedPaymentByProviderOrderId(providerOrderId, captureResponse);
  } catch (error) {
    const isAlreadyCaptured = error?.response?.data?.name === "UNPROCESSABLE_ENTITY";
    if (!isAlreadyCaptured) {
      throw error;
    }
    return finalizeCompletedPayPalOrderByProviderOrderId(providerOrderId, error);
  }
}

export async function handlePayPalWebhook(event) {
  if (event.event_type === "CHECKOUT.ORDER.APPROVED") {
    const providerOrderId = event.resource?.id;
    if (providerOrderId) {
      try {
        const captureResponse = await capturePayPalOrder(providerOrderId);
        await finalizeCapturedPaymentByProviderOrderId(providerOrderId, captureResponse);
      } catch (error) {
        const isAlreadyProcessed =
          error?.response?.data?.name === "UNPROCESSABLE_ENTITY";
        if (!isAlreadyProcessed) {
          throw error;
        }
        await finalizeCompletedPayPalOrderByProviderOrderId(providerOrderId, error);
      }
    }
  }

  if (event.event_type === "PAYMENT.CAPTURE.COMPLETED") {
    const providerOrderId = event.resource?.supplementary_data?.related_ids?.order_id;
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

  if (event.event_type === "PAYMENT.CAPTURE.DENIED") {
    const orderId = event.resource?.supplementary_data?.related_ids?.order_id;
    if (orderId) {
      await prisma.payment.updateMany({
        where: { providerOrderId: orderId },
        data: { status: "FAILED" },
      });
    }
  }

  return { accepted: true };
}
