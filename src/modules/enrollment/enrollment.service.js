import { prisma } from "../../shared/database/prisma.js";
import { getPagination, toPagedResult } from "../../shared/utils/pagination.js";

export async function listMyEnrollments(userId, query) {
  const { page, limit, skip } = getPagination(query);
  const where = {
    userId,
    status: query.status || undefined,
  };
  const [rows, total] = await Promise.all([
    prisma.enrollment.findMany({
      where,
      skip,
      take: limit,
      include: {
        course: {
          include: {
            educator: {
              select: { id: true, username: true, firstName: true, lastName: true },
            },
            sections: {
              include: {
                lessons: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.enrollment.count({ where }),
  ]);
  return toPagedResult(rows, total, page, limit);
}
