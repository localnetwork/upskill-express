import { prisma } from "../../shared/database/prisma.js";

function buildUserListWhere({ search, role, status } = {}) {
  const where = {
    deletedAt: null,
  };

  if (search) {
    where.OR = [
      { id: { contains: search, mode: "insensitive" } },
      { email: { contains: search, mode: "insensitive" } },
      { username: { contains: search, mode: "insensitive" } },
      { firstName: { contains: search, mode: "insensitive" } },
      { lastName: { contains: search, mode: "insensitive" } },
    ];
  }

  if (role) {
    where.roles = {
      some: {
        role: {
          name: role,
        },
      },
    };
  }

  if (status === "ACTIVE") {
    where.isActive = true;
    where.emailVerifiedAt = { not: null };
  } else if (status === "SUSPENDED") {
    where.isActive = false;
  } else if (status === "PENDING") {
    where.isActive = true;
    where.emailVerifiedAt = null;
  }

  return where;
}

export function findByEmail(email) {
  return prisma.user.findUnique({
    where: { email },
  });
}

export function findByUsername(username) {
  return prisma.user.findUnique({
    where: { username },
  });
}

export function create(data) {
  return prisma.user.create({
    data,
  });
}

export function findById(id) {
  return prisma.user.findUnique({
    where: { id },
    include: {
      roles: {
        include: { role: true },
      },
    },
  });
}

export function findMany({ skip, limit, search, role, status }) {
  return prisma.user.findMany({
    where: buildUserListWhere({ search, role, status }),
    skip,
    take: limit,
    orderBy: { createdAt: "desc" },
    include: {
      roles: {
        include: { role: true },
      },
    },
  });
}

export function countMany({ search, role, status }) {
  return prisma.user.count({
    where: buildUserListWhere({ search, role, status }),
  });
}

export function updateById(id, data) {
  return prisma.user.update({
    where: { id },
    data,
  });
}
