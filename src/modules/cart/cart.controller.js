import { addToCart, getCart, removeFromCart } from "./cart.service.js";

export async function getCartController(req, res) {
  const data = await getCart(req.user.id);
  return res.json({ message: "Cart fetched", data });
}

export async function addToCartController(req, res) {
  const data = await addToCart(req.user.id, req.body.courseId);
  return res.status(201).json({ message: "Added to cart", data });
}

export async function removeFromCartController(req, res) {
  const data = await removeFromCart(req.user.id, req.params.courseId);
  return res.json({ message: "Removed from cart", data });
}
