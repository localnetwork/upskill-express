import { prisma } from "../../shared/database/prisma.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { calculateTax } from "./tax.service.js";
import { capturePayPalOrder, createPayPalOrder } from "./paypal.service.js";
import { createNotification } from "../notification/notification.service.js";

function decimal(value) {
  return Number(value || 0);
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

export async function createCheckoutOrder(userId, payload) {
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

  const courseIds = cart.items.map((item) => item.courseId);
  const existingEnrollments = await prisma.enrollment.findMany({
    where: {
      userId,
      courseId: { in: courseIds },
    },
  });
  if (existingEnrollments.length > 0) {
    throw new ApiError(400, "Cannot buy an already enrolled course");
  }

  const subtotal = cart.items.reduce(
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
  const providerOrder = await createPayPalOrder({
    amount: totalAmount,
    currency: "USD",
    referenceId: `cart-${cart.id}`,
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
        currency: "USD",
        platformFeeAmount: 0,
        educatorEarnings: 0,
      },
    });

    let sumPlatformFee = 0;
    let sumEducatorEarnings = 0;

    for (const item of cart.items) {
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
        currency: "USD",
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

  if (!payment || payment.order.userId !== userId) {
    throw new ApiError(404, "Payment not found");
  }
  if (payment.status === "CAPTURED") {
    throw new ApiError(400, "Payment already captured");
  }

  const captureResponse = await capturePayPalOrder(providerOrderId);
  const captureId =
    captureResponse.purchase_units?.[0]?.payments?.captures?.[0]?.id || null;

  if (!captureId) {
    throw new ApiError(400, "Unable to capture payment");
  }

  const result = await prisma.$transaction(async (tx) => {
    await tx.payment.update({
      where: { id: payment.id },
      data: {
        providerCaptureId: captureId,
        status: "CAPTURED",
        capturedAt: new Date(),
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
            userId,
            courseId: item.courseId,
          },
        },
        update: {},
        create: {
          userId,
          courseId: item.courseId,
          orderId: payment.orderId,
          orderItemId: item.id,
          status: "ACTIVE",
        },
      });
    }

    const cart = await tx.cart.findUnique({ where: { userId } });
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

    return tx.order.findUnique({
      where: { id: payment.orderId },
      include: { items: true },
    });
  });

  await createNotification({
    userId,
    type: "ORDER",
    title: "Payment successful",
    message: `Order ${result.id} has been paid and enrollments are active.`,
    metadata: { orderId: result.id },
  });

  return {
    order: result,
    paypalCapture: captureResponse,
  };
}

export async function handlePayPalWebhook(event) {
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
