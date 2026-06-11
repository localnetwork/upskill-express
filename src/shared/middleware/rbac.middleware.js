import { ApiError } from "../utils/ApiError.js";

export function authorize(...allowedRoles) {
  return (req, _res, next) => {
    const userRoles = req.user?.roles || [];
    const allowed = allowedRoles.some((role) => userRoles.includes(role));
    if (!allowed) {
      return next(new ApiError(403, "Forbidden"));
    }
    return next();
  };
}
