import { prisma } from "../../shared/database/prisma.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { ROLE_GUIDES } from "../../shared/constants/staffRoles.js";
import { hashPassword } from "../../shared/utils/security.js";

const SYSTEM_ROLES = ["ADMIN", "EDUCATOR", "LEARNER"];

function mapRole(role) {
  const guide = ROLE_GUIDES[role.name] || null;
  return {
    id: role.id,
    name: role.name,
    description: role.description || "",
    label: guide?.label || role.name,
    kind: guide?.kind || "Custom",
    summary: guide?.summary || role.description || "",
    access: guide?.access || [],
    restrictions: guide?.restrictions || [],
    permissions: (role.permissions || [])
      .map((row) => row.permission)
      .filter(Boolean)
      .map((permission) => ({
        name: permission.name,
        description: permission.description || "",
      })),
    is_system: Boolean(role.isSystem) || SYSTEM_ROLES.includes(role.name),
    user_count: role._count?.users ?? 0,
    permission_ids: (role.permissions || []).map((row) => row.permissionId),
    created_at: role.createdAt,
  };
}

const roleInclude = {
  permissions: {
    select: {
      permissionId: true,
      permission: { select: { name: true, description: true } },
    },
  },
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

export async function setUserStaffRoles(actorId, userId, roleNames = []) {
  const user = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    include: { roles: { include: { role: true } } },
  });
  if (!user) throw new ApiError(404, "User not found");
  if (actorId === userId) {
    throw new ApiError(403, "You cannot change your own staff roles");
  }

  const names = Array.from(
    new Set(roleNames.map((name) => String(name).trim().toUpperCase())),
  );
  const roles = names.length
    ? await prisma.role.findMany({ where: { name: { in: names } } })
    : [];
  if (roles.length !== names.length) {
    throw new ApiError(400, "One or more roles do not exist");
  }
  if (roles.some((role) => role.isSystem || SYSTEM_ROLES.includes(role.name))) {
    throw new ApiError(400, "Only staff roles can be assigned here");
  }

  const currentStaffRoleIds = user.roles
    .filter((row) => !row.role.isSystem && !SYSTEM_ROLES.includes(row.role.name))
    .map((row) => row.roleId);
  const nextRoleIds = roles.map((role) => role.id);

  await prisma.$transaction([
    prisma.userRole.deleteMany({
      where: {
        userId,
        roleId: { in: currentStaffRoleIds.filter((id) => !nextRoleIds.includes(id)) },
      },
    }),
    prisma.userRole.createMany({
      data: nextRoleIds
        .filter((id) => !currentStaffRoleIds.includes(id))
        .map((roleId) => ({ userId, roleId })),
      skipDuplicates: true,
    }),
    prisma.user.update({ where: { id: userId }, data: { refreshTokenHash: null } }),
  ]);

  const updated = await prisma.userRole.findMany({
    where: { userId },
    include: { role: true },
  });
  return { userId, roles: updated.map((row) => row.role.name) };
}

export async function createUserByAdmin(payload) {
  const email = String(payload.email).trim().toLowerCase();
  const username = String(payload.username).trim();

  const [existingEmail, existingUsername] = await Promise.all([
    prisma.user.findFirst({ where: { email: { equals: email, mode: "insensitive" } } }),
    prisma.user.findFirst({ where: { username: { equals: username, mode: "insensitive" } } }),
  ]);
  if (existingEmail) throw new ApiError(409, "Email already in use");
  if (existingUsername) throw new ApiError(409, "Username already in use");

  const names = Array.from(
    new Set(
      [payload.baseRole, ...(payload.staffRoles || [])]
        .filter(Boolean)
        .map((name) => String(name).trim().toUpperCase()),
    ),
  );
  if (!names.length) throw new ApiError(400, "Assign at least one role");
  if (names.includes("ADMIN")) {
    throw new ApiError(400, "Admin accounts cannot be created from here");
  }

  const roles = await prisma.role.findMany({ where: { name: { in: names } } });
  if (roles.length !== names.length) {
    throw new ApiError(400, "One or more roles do not exist");
  }
  const staffRoleNames = payload.staffRoles || [];
  if (
    roles.some(
      (role) =>
        staffRoleNames.map((n) => n.toUpperCase()).includes(role.name) &&
        (role.isSystem || SYSTEM_ROLES.includes(role.name)),
    )
  ) {
    throw new ApiError(400, "Only staff roles can be listed as staff roles");
  }

  const user = await prisma.user.create({
    data: {
      email,
      username,
      firstName: payload.firstName || null,
      lastName: payload.lastName || null,
      passwordHash: await hashPassword(payload.password),
      emailVerifiedAt: new Date(),
      roles: { create: roles.map((role) => ({ roleId: role.id })) },
    },
    select: { id: true, email: true, username: true },
  });

  return { ...user, roles: roles.map((role) => role.name) };
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
