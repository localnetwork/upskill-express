import { getMyLearningPaths } from "./learning-path.service.js";

export async function getMyLearningPathsController(req, res) {
  const data = await getMyLearningPaths(req.user.id);
  return res.json({ message: "Learning paths fetched", data });
}
