import { prisma } from "../../shared/database/prisma.js";

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

export function findMany({ skip, limit, search }) {
  return prisma.user.findMany({
    where: {
      deletedAt: null,
      OR: search
        ? [
            { email: { contains: search, mode: "insensitive" } },
            { username: { contains: search, mode: "insensitive" } },
          ]
        : undefined,
    },
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

export function countMany(search) {
  return prisma.user.count({
    where: {
      deletedAt: null,
      OR: search
        ? [
            { email: { contains: search, mode: "insensitive" } },
            { username: { contains: search, mode: "insensitive" } },
          ]
        : undefined,
    },
  });
}

export function updateById(id, data) {
  return prisma.user.update({
    where: { id },
    data,
  });
}
