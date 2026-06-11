import { getMyOrder, listMyOrders } from "./order.service.js";

export async function listMyOrdersController(req, res) {
  const data = await listMyOrders(req.user.id, req.query);
  return res.json({ message: "Orders fetched", ...data });
}

export async function getMyOrderController(req, res) {
  const data = await getMyOrder(req.user.id, req.params.orderId);
  return res.json({ message: "Order fetched", data });
}
