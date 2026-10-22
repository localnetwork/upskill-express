import { getMyOrder, listMyOrders } from "./order.service.js";
import { buildOrderInvoicePdf, getInvoiceFileName } from "./order.invoice.js";

export async function downloadMyOrderInvoiceController(req, res) {
  const pdf = await buildOrderInvoicePdf(req.user.id, req.params.orderId);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${getInvoiceFileName(req.params.orderId)}"`,
  );
  res.setHeader("Content-Length", pdf.length);
  return res.send(pdf);
}

export async function listMyOrdersController(req, res) {
  const data = await listMyOrders(req.user.id, req.query);
  return res.json({ message: "Orders fetched", ...data });
}

export async function getMyOrderController(req, res) {
  const data = await getMyOrder(req.user.id, req.params.orderId);
  return res.json({ message: "Order fetched", data });
}
