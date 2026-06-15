import {
  createReview,
  getReviewEligibility,
  listCourseReviews,
  listInstructorReviews,
  toggleReviewLike,
} from "./review.service.js";

export async function createReviewController(req, res) {
  const data = await createReview(req.user.id, req.body);
  return res.status(201).json({ message: "Review created", data });
}

export async function listCourseReviewsController(req, res) {
  const data = await listCourseReviews(req.params.courseId, req.query, req.user?.id || null);
  return res.json({ message: "Reviews fetched", ...data });
}

export async function getReviewEligibilityController(req, res) {
  const data = await getReviewEligibility(req.user?.id || null, req.params.courseId);
  return res.json({ message: "Review eligibility fetched", data });
}

export async function listInstructorReviewsController(req, res) {
  const data = await listInstructorReviews(req.user.id, req.query);
  return res.json({ message: "Instructor reviews fetched", ...data });
}

export async function toggleReviewLikeController(req, res) {
  const data = await toggleReviewLike(req.user.id, req.params.reviewId);
  return res.json({ message: data.liked ? "Review liked" : "Review unliked", data });
}
