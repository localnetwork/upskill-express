import { prisma } from "../../shared/database/prisma.js";
import { activeEnrollmentFilter } from "../access/access.service.js";

const MAX_PATHS = 4;
const MAX_COURSES_PER_PATH = 12;
const PUBLISHED_COURSE = {
  deletedAt: null,
  OR: [{ workflowStatus: "PUBLISHED" }, { isPublished: true }],
};

function mapCover(media = []) {
  const cover = media.find((m) => ["COVER_IMAGE", "IMAGE"].includes(m.mediaType));
  return cover ? { id: cover.id, path: cover.storagePath } : null;
}

function mapCourse(course, enrollment) {
  const progressPct = Number(enrollment?.courseProgress?.progressPct || 0);
  const completed = Boolean(enrollment?.completedAt) || progressPct >= 100;
  let status = "not_enrolled";
  if (enrollment) status = completed ? "completed" : progressPct > 0 ? "in_progress" : "enrolled";

  return {
    id: course.id,
    slug: course.slug,
    title: course.title,
    cover_image: mapCover(course.media),
    level: course.level?.title || null,
    level_weight: course.level?.weight ?? 0,
    status,
    progress_pct: completed ? 100 : progressPct,
  };
}

/**
 * Builds learning paths from what the learner actually does: categories they are enrolled in
 * (ranked by recent activity) plus categories of courses they wishlisted. Each path orders the
 * category's courses from beginner to advanced and points to the next step.
 */
export async function getMyLearningPaths(userId) {
  const [enrollments, wishlist] = await Promise.all([
    prisma.enrollment.findMany({
      where: { userId, ...activeEnrollmentFilter(), course: { categoryId: { not: null } } },
      select: {
        courseId: true,
        completedAt: true,
        updatedAt: true,
        courseProgress: { select: { progressPct: true, updatedAt: true } },
        course: { select: { categoryId: true } },
      },
    }),
    prisma.wishlist.findMany({
      where: { userId, course: { categoryId: { not: null } } },
      select: { createdAt: true, course: { select: { categoryId: true } } },
    }),
  ]);

  const enrollmentByCourse = new Map(enrollments.map((e) => [e.courseId, e]));

  const signals = new Map();
  for (const enrollment of enrollments) {
    const categoryId = enrollment.course.categoryId;
    const activity = Math.max(
      enrollment.updatedAt?.getTime() || 0,
      enrollment.courseProgress?.updatedAt?.getTime() || 0,
    );
    const current = signals.get(categoryId);
    signals.set(categoryId, {
      reason: "enrolled",
      lastActivity: Math.max(current?.lastActivity || 0, activity),
    });
  }
  for (const item of wishlist) {
    const categoryId = item.course.categoryId;
    if (signals.has(categoryId)) continue;
    signals.set(categoryId, {
      reason: "wishlist",
      lastActivity: item.createdAt.getTime(),
    });
  }

  // Active learning first, wishlist-driven suggestions after.
  const rankedCategoryIds = [...signals.entries()]
    .sort(([, a], [, b]) => {
      if (a.reason !== b.reason) return a.reason === "enrolled" ? -1 : 1;
      return b.lastActivity - a.lastActivity;
    })
    .slice(0, MAX_PATHS)
    .map(([categoryId]) => categoryId);

  if (!rankedCategoryIds.length) return { paths: [] };

  const [categories, courses] = await Promise.all([
    prisma.category.findMany({
      where: { id: { in: rankedCategoryIds }, deletedAt: null },
      select: { id: true, name: true, slug: true },
    }),
    prisma.course.findMany({
      where: { ...PUBLISHED_COURSE, categoryId: { in: rankedCategoryIds } },
      select: {
        id: true,
        slug: true,
        title: true,
        categoryId: true,
        level: { select: { title: true, weight: true } },
        media: {
          where: { mediaType: { in: ["COVER_IMAGE", "IMAGE"] } },
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { id: true, mediaType: true, storagePath: true },
        },
      },
    }),
  ]);

  const categoryById = new Map(categories.map((c) => [c.id, c]));
  const coursesByCategory = new Map();
  for (const course of courses) {
    const list = coursesByCategory.get(course.categoryId) || [];
    list.push(course);
    coursesByCategory.set(course.categoryId, list);
  }

  const paths = [];
  for (const categoryId of rankedCategoryIds) {
    const category = categoryById.get(categoryId);
    const categoryCourses = coursesByCategory.get(categoryId) || [];
    if (!category || !categoryCourses.length) continue;

    const items = categoryCourses
      .map((course) => mapCourse(course, enrollmentByCourse.get(course.id)))
      .sort((a, b) => a.level_weight - b.level_weight || a.title.localeCompare(b.title))
      .slice(0, MAX_COURSES_PER_PATH);

    const completedCount = items.filter((c) => c.status === "completed").length;
    const enrolledCount = items.filter((c) => c.status !== "not_enrolled").length;
    const progressPct = Math.round(
      items.reduce((sum, c) => sum + c.progress_pct, 0) / items.length,
    );
    const nextCourse =
      items.find((c) => c.status === "in_progress") ||
      items.find((c) => c.status === "enrolled") ||
      items.find((c) => c.status === "not_enrolled") ||
      null;
    const levels = items.map((c) => c.level).filter(Boolean);

    paths.push({
      id: category.id,
      title: `${category.name} path`,
      category,
      reason: signals.get(categoryId).reason,
      total_courses: items.length,
      enrolled_courses: enrolledCount,
      completed_courses: completedCount,
      progress_pct: progressPct,
      levels_label:
        levels.length > 1 && levels[0] !== levels[levels.length - 1]
          ? `${levels[0]} to ${levels[levels.length - 1]}`
          : levels[0] || null,
      next_course: nextCourse,
      courses: items,
    });
  }

  return { paths };
}
