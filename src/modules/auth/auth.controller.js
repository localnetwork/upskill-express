import { forgotPassword, login, refreshTokens, register, resetPassword, verifyEmail } from "./auth.service.js";

export async function registerController(req, res) {
  const result = await register(req.body);
  return res.status(201).json({
    message: "User registered",
    data: result,
  });
}

export async function loginController(req, res) {
  const result = await login(req.body);
  return res.status(200).json({
    message: "Login successful",
    data: result,
  });
}

export async function refreshTokenController(req, res) {
  const result = await refreshTokens(req.body.refreshToken);
  return res.status(200).json({
    message: "Token refreshed",
    data: result,
  });
}

export async function forgotPasswordController(req, res) {
  const result = await forgotPassword(req.body.email);
  return res.status(200).json({
    message: "Password reset initiated",
    data: result,
  });
}

export async function resetPasswordController(req, res) {
  const result = await resetPassword(req.body.token, req.body.password);
  return res.status(200).json({
    message: "Password reset successful",
    data: result,
  });
}

export async function verifyEmailController(req, res) {
  const result = await verifyEmail(req.body.token);
  return res.status(200).json({
    message: "Email verified",
    data: result,
  });
}