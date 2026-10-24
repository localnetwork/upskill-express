export const BASE_ROLES = ["ADMIN", "EDUCATOR", "LEARNER"];

export const STAFF_PERMISSIONS = {
  "courses.list": "View the admin course list and review queue",
  "courses.review": "Preview course curriculum, lecture content and course details",
  "courses.approve": "Approve submitted courses",
  "courses.reject": "Reject submitted courses",
  "categories.manage": "Create, edit and delete categories",
  "tags.manage": "Create, edit and delete tags",
  "users.view": "View the user list",
  "users.suspend": "Suspend or reactivate user accounts",
  "users.manage": "Edit user profiles",
  "payouts.manage": "Review, approve, reject and execute payouts",
  "reports.view": "View platform activity reports",
  "reports.revenue": "View revenue reports",
  "settings.view": "View platform settings",
  "settings.manage": "Change platform settings",
};

export const STAFF_ROLES = {
  FINANCE_OFFICER: {
    description: "Handles payouts, revenue reports and platform fee settings",
    permissions: [
      "payouts.manage",
      "reports.revenue",
      "settings.view",
      "settings.manage",
    ],
  },
  COURSE_REVIEWER: {
    description: "Reviews submitted courses and curates tags",
    permissions: [
      "courses.list",
      "courses.review",
      "courses.approve",
      "courses.reject",
      "tags.manage",
    ],
  },
  SUPPORT_AGENT: {
    description: "Looks up users and suspends or reactivates accounts",
    permissions: ["users.view", "users.suspend", "courses.list"],
  },
  ANALYST: {
    description: "Read-only access to reports and the course list",
    permissions: ["reports.view", "reports.revenue", "courses.list"],
  },
};

export const STAFF_ROLE_NAMES = Object.keys(STAFF_ROLES);

// Grants removed from seeded roles; the seeder revokes them from existing databases.
export const REVOKED_STAFF_GRANTS = {
  COURSE_REVIEWER: ["categories.manage"],
};

export const ROLE_GUIDES = {
  ADMIN: {
    label: "Administrator",
    kind: "Platform",
    summary:
      "Full platform control. Reserved for a few trusted owners; day-to-day operations should use staff roles.",
    access: [
      "Everything every other role can do (bypasses all permission checks)",
      "Create users and assign or remove staff roles",
      "Create, edit and delete roles and their permissions",
      "Delete user accounts and suspend other admins",
      "All admin tabs: courses, users, categories, tags, payouts, reports and platform settings",
    ],
    restrictions: ["Cannot change their own staff roles or suspend their own account"],
  },
  EDUCATOR: {
    label: "Educator",
    kind: "Platform",
    summary: "Creates and sells courses. Self-service role used by instructors.",
    access: [
      "Create, edit and submit their own courses for review",
      "Manage their own curriculum, lectures and pricing",
      "View their own students, earnings and performance",
      "Request payouts and manage payout settings",
      "Message learners",
    ],
    restrictions: ["No access to the admin or employee dashboards", "Cannot see other educators' data"],
  },
  LEARNER: {
    label: "Learner",
    kind: "Platform",
    summary: "Buys and takes courses. The default role for every new account.",
    access: [
      "Browse and purchase courses",
      "Watch purchased courses and track progress",
      "Leave reviews and ask questions",
      "Manage their own profile and devices",
    ],
    restrictions: ["No access to educator tools, admin or employee dashboards"],
  },
  FINANCE_OFFICER: {
    label: "Finance Officer",
    kind: "Staff",
    summary: "Handles money movement: educator payouts, revenue visibility and platform fees.",
    access: [
      "Review, approve, reject and execute educator payouts",
      "View revenue reports",
      "View and change platform settings such as platform fee",
      "Opens the Employee Dashboard: Payouts, Reports and Platform Settings tabs",
    ],
    restrictions: [
      "Cannot approve or reject courses",
      "Cannot view or suspend users",
      "Cannot manage categories or tags",
    ],
  },
  COURSE_REVIEWER: {
    label: "Course Reviewer",
    kind: "Staff",
    summary: "Quality gate for the catalog: checks submitted courses and keeps taxonomy tidy.",
    access: [
      "See the course review queue",
      "Preview curriculum, lectures (including video playback) and course details",
      "Approve or reject submitted courses with feedback",
      "Create, edit and delete tags",
      "Opens the Employee Dashboard: Course Review and Tags tabs",
    ],
    restrictions: [
      "Cannot manage categories",
      "Cannot see a course's students or statistics",
      "Cannot edit course content",
      "Cannot access payouts, reports or user accounts",
    ],
  },
  SUPPORT_AGENT: {
    label: "Support Agent",
    kind: "Staff",
    summary: "First-line support: finds users and handles account problems.",
    access: [
      "Search and view the user list",
      "Suspend and reactivate learner and educator accounts",
      "View the course list to help users find a course",
      "Opens the Employee Dashboard: Users and Course Review (list only) tabs",
    ],
    restrictions: [
      "Cannot edit user profiles or delete users",
      "Cannot suspend admins or users with the same role",
      "Cannot preview course content or approve courses",
      "Cannot access payouts or revenue",
    ],
  },
  ANALYST: {
    label: "Analyst",
    kind: "Staff",
    summary: "Read-only insight into platform activity and revenue.",
    access: [
      "View platform activity reports",
      "View revenue reports",
      "View the course list",
      "Opens the Employee Dashboard: Reports and Course Review (list only) tabs",
    ],
    restrictions: ["Read-only: cannot change anything", "Cannot view users or payouts"],
  },
};
