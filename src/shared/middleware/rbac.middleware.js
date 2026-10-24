import { ApiError } from "../utils/ApiError.js";

const ROLE_ALIASES = {
  INSTRUCTOR: "EDUCATOR",
  STUDENT: "LEARNER",
};

function normalizeRoleName(role) {
  const normalized = String(role || "")
    .trim()
    .toUpperCase();
  return ROLE_ALIASES[normalized] || normalized;
}

// Allows ADMIN (super-admin) or any user whose role grants at least one of the permissions.
export function authorizePermission(...permissions) {
  return (req, _res, next) => {
    const userRoles = (req.user?.roles || []).map(normalizeRoleName);
    if (userRoles.includes("ADMIN")) return next();
    const granted = new Set(req.user?.permissions || []);
    if (permissions.some((permission) => granted.has(permission))) {
      return next();
    }
    return next(new ApiError(403, "Forbidden"));
  };
}

export function authorize(...allowedRoles) {
  return (req, _res, next) => {
    const userRoles = (req.user?.roles || []).map(normalizeRoleName);
    const normalizedAllowedRoles = allowedRoles.map(normalizeRoleName);
    const allowed = normalizedAllowedRoles.some((role) =>
      userRoles.includes(role),
    );
    if (!allowed) {
      return next(new ApiError(403, "Forbidden"));
    }
    return next();
  };
}
