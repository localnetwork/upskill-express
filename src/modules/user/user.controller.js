import {
  changePassword,
  getCurrentUser,
  listCurrentUserActivity,
  listUsers,
  softDeleteUser,
  updateCurrentUser,
} from "./user.service.js";

export async function meController(req, res) {
  const data = await getCurrentUser(req.user.id);
  return res.json({ message: "Profile fetched", data });
}

export async function updateMeController(req, res) {
  const data = await updateCurrentUser(req.user.id, req.body);
  return res.json({ message: "Profile updated", data });
}

export async function listMyActivityController(req, res) {
  const data = await listCurrentUserActivity(req.user.id, req.query);
  return res.json({ message: "Activity fetched", ...data });
}

export async function changePasswordController(req, res) {
  const data = await changePassword(req.user.id, req.body.oldPassword, req.body.newPassword);
  return res.json({ message: "Password changed", data });
}

export async function listUsersController(req, res) {
  const data = await listUsers(req.query);
  return res.json({ message: "Users fetched", ...data });
}

export async function deleteUserController(req, res) {
  const data = await softDeleteUser(req.params.userId);
  return res.json({ message: "User deleted", data });
}
