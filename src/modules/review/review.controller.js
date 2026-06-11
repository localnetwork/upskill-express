import { createReview, listCourseReviews } from "./review.service.js";

export async function createReviewController(req, res) {
  const data = await createReview(req.user.id, req.body);
  return res.status(201).json({ message: "Review created", data });
}

export async function listCourseReviewsController(req, res) {
  const data = await listCourseReviews(req.params.courseId, req.query);
  return res.json({ message: "Reviews fetched", ...data });
}
