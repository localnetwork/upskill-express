import { prisma } from "../../shared/database/prisma.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { getPagination, toPagedResult } from "../../shared/utils/pagination.js";
import { COURSE_REPORT_ISSUE_TYPES } from "../../shared/constants/courseReports.js";

const REPORT_STATUSES = new Set(["OPEN", "DISMISSED", "ACTIONED"]);

export async function createCourseReport(userId, courseIdOrSlug, { issueType, details }) {
  const course = await prisma.course.findFirst({
    where: {
      deletedAt: null,
      workflowStatus: { in: ["PUBLISHED", "SUSPENDED"] },
      OR: [{ id: courseIdOrSlug }, { slug: courseIdOrSlug }],
    },
    select: { id: true, educatorId: true },
  });
  if (!course) {
    throw new ApiError(404, "Course not found");
  }
  if (course.educatorId === userId) {
    throw new ApiError(400, "You cannot report your own course");
  }

  const existing = await prisma.courseReport.findFirst({
    where: { courseId: course.id, reporterId: userId, status: "OPEN" },
    select: { id: true },
  });
  if (existing) {
    throw new ApiError(409, "You have already reported this course. Our team is reviewing it.");
  }

  const report = await prisma.courseReport.create({
    data: {
      courseId: course.id,
      reporterId: userId,
      issueType,
      details: details.trim(),
    },
  });
  return { id: report.id, status: report.status };
}

export async function listAdminCourseReports(query = {}) {
  const { page, limit, skip } = getPagination(query);
  const rawStatus = String(query.status || "OPEN").trim().toUpperCase();
  const status = REPORT_STATUSES.has(rawStatus) ? rawStatus : null;
  const search = typeof query.search === "string" ? query.search.trim() : "";

  const where = {
    status: status || undefined,
    course: { deletedAt: null },
    ...(search
      ? {
          OR: [
            { course: { title: { contains: search, mode: "insensitive" } } },
            { reporter: { username: { contains: search, mode: "insensitive" } } },
            { reporter: { email: { contains: search, mode: "insensitive" } } },
            { details: { contains: search, mode: "insensitive" } },
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    prisma.courseReport.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: "desc" },
      include: {
        reporter: { select: { id: true, username: true, fullName: true, email: true } },
        course: {
          select: {
            id: true,
            slug: true,
            title: true,
            workflowStatus: true,
            educator: { select: { id: true, username: true, fullName: true, email: true } },
          },
        },
      },
    }),
    prisma.courseReport.count({ where }),
  ]);

  const courseIds = [...new Set(rows.map((row) => row.courseId))];
  const openCounts = courseIds.length
    ? await prisma.courseReport.groupBy({
        by: ["courseId"],
        where: { courseId: { in: courseIds }, status: "OPEN" },
        _count: { _all: true },
      })
    : [];
  const openCountByCourse = new Map(openCounts.map((row) => [row.courseId, row._count._all]));

  const data = rows.map((row) => ({
    ...row,
    issueLabel: COURSE_REPORT_ISSUE_TYPES[row.issueType] || row.issueType,
    courseOpenReports: openCountByCourse.get(row.courseId) || 0,
  }));

  return toPagedResult(data, total, page, limit);
}

export async function countOpenCourseReports() {
  return prisma.courseReport.count({ where: { status: "OPEN", course: { deletedAt: null } } });
}

export async function dismissCourseReport(adminId, reportId, note) {
  const report = await prisma.courseReport.findUnique({ where: { id: reportId } });
  if (!report) {
    throw new ApiError(404, "Report not found");
  }
  if (report.status !== "OPEN") {
    throw new ApiError(400, "Report is already resolved");
  }

  return prisma.courseReport.update({
    where: { id: reportId },
    data: {
      status: "DISMISSED",
      resolvedById: adminId,
      resolvedAt: new Date(),
      resolutionNote: typeof note === "string" && note.trim() ? note.trim() : null,
    },
  });
}
