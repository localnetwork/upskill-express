import {
  googleAuth,
  login,
  refreshTokens,
  requestRegistrationCode,
  verifyLoginCode,
  verifyRegistration,
} from "./auth.service.js";

export async function registerRequestController(req, res) {
  const result = await requestRegistrationCode(req.body);
  return res.status(200).json({
    message: "Verification code sent",
    data: result,
  });
}

export async function registerVerifyController(req, res) {
  const result = await verifyRegistration(req.body, { req });
  return res.status(201).json({
    message: "User registered",
    data: result,
  });
}

export async function loginController(req, res) {
  const result = await login(req.body, { req });
  return res.status(200).json({
    message: result.requires_email_code
      ? "Login code sent"
      : "Login successful",
    data: result,
  });
}

export async function loginVerifyController(req, res) {
  const result = await verifyLoginCode(req.body, { req });
  return res.status(200).json({
    message: "Login successful",
    data: result,
  });
}

export async function googleAuthController(req, res) {
  const result = await googleAuth(req.body, { req });
  return res.status(200).json({
    message:
      req.body.intent === "register"
        ? "Google registration successful"
        : "Google login successful",
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
