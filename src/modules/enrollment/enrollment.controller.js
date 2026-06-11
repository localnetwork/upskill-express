import { listMyEnrollments } from "./enrollment.service.js";

export async function listMyEnrollmentsController(req, res) {
  const data = await listMyEnrollments(req.user.id, req.query);
  return res.json({ message: "Enrollments fetched", ...data });
}
