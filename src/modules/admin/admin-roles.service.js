import { prisma } from "../../shared/database/prisma.js";
import { ApiError } from "../../shared/utils/ApiError.js";

const SYSTEM_ROLES = ["ADMIN", "EDUCATOR", "LEARNER"];

function mapRole(role) {
  return {
    id: role.id,
    name: role.name,
    description: role.description || "",
    is_system: Boolean(role.isSystem) || SYSTEM_ROLES.includes(role.name),
    user_count: role._count?.users ?? 0,
    permission_ids: (role.permissions || []).map((row) => row.permissionId),
    created_at: role.createdAt,
  };
}

const roleInclude = {
  permissions: { select: { permissionId: true } },
  _count: { select: { users: true } },
};

export async function listPermissions() {
  const permissions = await prisma.permission.findMany({
    orderBy: { name: "asc" },
    include: {
      roles: { select: { role: { select: { id: true, name: true } } } },
    },
  });

  return permissions.map((permission) => ({
    id: permission.id,
    name: permission.name,
    description: permission.description || "",
    group: permission.name.includes(".") ? permission.name.split(".")[0] : "general",
    roles: permission.roles.map((row) => row.role),
  }));
}

export async function listRoles() {
  const roles = await prisma.role.findMany({
    orderBy: { createdAt: "asc" },
    include: roleInclude,
  });
  return roles
    .map(mapRole)
    .sort(
      (a, b) =>
        Number(b.is_system) - Number(a.is_system) ||
        a.name.localeCompare(b.name),
    );
}

async function assertPermissionsExist(permissionIds) {
  if (!permissionIds.length) return;
  const found = await prisma.permission.count({
    where: { id: { in: permissionIds } },
  });
  if (found !== permissionIds.length) {
    throw new ApiError(400, "One or more permissions do not exist");
  }
}

export async function createRole({ name, description, permissionIds = [] }) {
  const normalizedName = String(name || "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");

  if (!/^[A-Z][A-Z0-9_]{1,39}$/.test(normalizedName)) {
    throw new ApiError(
      400,
      "Role name must be 2-40 characters, start with a letter, and use only letters, numbers or underscores",
    );
  }

  const existing = await prisma.role.findUnique({ where: { name: normalizedName } });
  if (existing) {
    throw new ApiError(409, "A role with this name already exists");
  }

  const ids = Array.from(new Set(permissionIds));
  await assertPermissionsExist(ids);

  const role = await prisma.role.create({
    data: {
      name: normalizedName,
      description: String(description || "").trim().slice(0, 255) || null,
      isSystem: false,
      permissions: { create: ids.map((permissionId) => ({ permissionId })) },
    },
    include: roleInclude,
  });
  return mapRole(role);
}

export async function setRolePermissions(roleId, permissionIds = []) {
  const role = await prisma.role.findUnique({ where: { id: roleId } });
  if (!role) throw new ApiError(404, "Role not found");

  const ids = Array.from(new Set(permissionIds));
  await assertPermissionsExist(ids);

  await prisma.$transaction([
    prisma.rolePermission.deleteMany({ where: { roleId } }),
    ...(ids.length
      ? [
          prisma.rolePermission.createMany({
            data: ids.map((permissionId) => ({ roleId, permissionId })),
          }),
        ]
      : []),
  ]);

  const updated = await prisma.role.findUnique({
    where: { id: roleId },
    include: roleInclude,
  });
  return mapRole(updated);
}

export async function deleteRole(roleId) {
  const role = await prisma.role.findUnique({
    where: { id: roleId },
    include: { _count: { select: { users: true } } },
  });
  if (!role) throw new ApiError(404, "Role not found");

  if (role.isSystem || SYSTEM_ROLES.includes(role.name)) {
    throw new ApiError(403, "Default roles (admin, educator, learner) cannot be deleted");
  }
  if (role._count.users > 0) {
    throw new ApiError(409, "This role is assigned to users. Unassign it first.");
  }

  await prisma.role.delete({ where: { id: roleId } });
  return { id: roleId };
}
