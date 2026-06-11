import { prisma } from "../../shared/database/prisma.js";

export function findUserByEmail(email) {
  return prisma.user.findUnique({
    where: { email },
    include: { roles: { include: { role: true } } },
  });
}

export function findUserByUsername(username) {
  return prisma.user.findUnique({
    where: { username },
    include: { roles: { include: { role: true } } },
  });
}

export function findUserById(id) {
  return prisma.user.findUnique({
    where: { id },
    include: { roles: { include: { role: true } } },
  });
}

export function createUser(data) {
  return prisma.user.create({ data });
}

export function updateUser(id, data) {
  return prisma.user.update({
    where: { id },
    data,
  });
}
