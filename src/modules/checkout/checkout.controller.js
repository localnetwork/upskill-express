import {
  cancelCheckoutOrder,
  captureCheckoutOrder,
  createCheckoutOrder,
  getCheckoutOrderStatus,
  handlePayPalWebhook,
} from "./checkout.service.js";

export async function createCheckoutController(req, res) {
  const data = await createCheckoutOrder(req.user.id, req.body);
  const approvalLink = data?.paypal?.links?.find((link) => link.rel === "approve")?.href || null;
  const transactionRedirect = data?.providerOrderId
    ? `/checkout/success?token=${encodeURIComponent(data.providerOrderId)}`
    : null;
  const fallbackRedirect = data?.freeCheckout
    ? `/my-courses/learning?order_id=${data.orderId}`
    : null;
  return res.status(201).json({
    message: data?.reusedCheckout
      ? "Existing checkout order found"
      : "Checkout order created",
    data,
    redirect_url: data?.reusedCheckout
      ? transactionRedirect || approvalLink || fallbackRedirect
      : approvalLink || fallbackRedirect,
  });
}

export async function captureCheckoutController(req, res) {
  const data = await captureCheckoutOrder(req.user?.id || null, req.body.providerOrderId);
  return res.json({ message: "Checkout order captured", data });
}

export async function cancelCheckoutController(req, res) {
  const data = await cancelCheckoutOrder(req.user?.id || null, req.body.providerOrderId);
  return res.json({ message: "Checkout order cancelled", data });
}

export async function getCheckoutStatusController(req, res) {
  const data = await getCheckoutOrderStatus(
    req.user?.id || null,
    req.params.providerOrderId,
  );
  return res.json({ message: "Checkout status fetched", data });
}

export async function webhookController(req, res) {
  const data = await handlePayPalWebhook(req.body);
  return res.status(202).json({ message: "Webhook accepted", data });
}
