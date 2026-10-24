export function isAdminUser(user) {
  return (
    Array.isArray(user?.roles) &&
    user.roles.some((role) => String(role || "").toUpperCase() === "ADMIN")
  );
}

export function hasPermission(user, permission) {
  return isAdminUser(user) || (user?.permissions || []).includes(permission);
}

// Admins and staff with courses.review may preview any course's curriculum and details.
export function canReviewCourseContent(user) {
  return hasPermission(user, "courses.review");
}
