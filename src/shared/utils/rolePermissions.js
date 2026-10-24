import { STAFF_ROLES } from "../constants/staffRoles.js";

const ROLE_PERMISSION_MAP = {
  ...Object.fromEntries(
    Object.entries(STAFF_ROLES).map(([name, def]) => [name, def.permissions]),
  ),
  ADMIN: ["admin"],
  EDUCATOR: [
    "add-course",
    "edit-own-courses",
    "view-own-earnings",
    "view-own-payment-settings",
  ],
  LEARNER: ["view-courses", "view-own-learnings"],
};

export function mapPermissionsFromRoles(roles = []) {
  if (!Array.isArray(roles)) return [];
  const permissions = roles.flatMap(
    (role) => ROLE_PERMISSION_MAP[String(role || "").toUpperCase()] || [],
  );
  return [...new Set(permissions)];
}
