const ROLE_PERMISSION_MAP = {
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
  const permissions = roles.flatMap((role) => ROLE_PERMISSION_MAP[String(role || "").toUpperCase()] || []);
  return [...new Set(permissions)];
}

