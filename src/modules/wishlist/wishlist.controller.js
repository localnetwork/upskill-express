import { addToWishlist, listWishlist, removeFromWishlist } from "./wishlist.service.js";

export async function listWishlistController(req, res) {
  const data = await listWishlist(req.user.id, req.query);
  return res.json({ message: "Wishlist fetched", ...data });
}

export async function addToWishlistController(req, res) {
  const courseId = req.body.courseId || req.body.course_id;
  const data = await addToWishlist(req.user.id, courseId);
  return res.status(201).json({ message: "Course added to wishlist", data });
}

export async function removeFromWishlistController(req, res) {
  const courseId = req.params.courseId;
  const data = await removeFromWishlist(req.user.id, courseId);
  return res.json({ message: "Course removed from wishlist", data });
}

