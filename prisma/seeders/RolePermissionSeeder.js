import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

export default class RolePermissionSeeder {
  constructor() {
    this.weight = 5;
  }

  async run() {
    const roles = ["ADMIN", "EDUCATOR", "LEARNER"];

    const permissionsByRole = {
      ADMIN: [
        "users.manage",
        "categories.manage",
        "courses.approve",
        "courses.reject",
        "payouts.manage",
        "reports.view",
      ],
      EDUCATOR: [
        "courses.create",
        "courses.update",
        "courses.submit_for_approval",
        "curriculum.manage",
        "earnings.view",
        "payouts.request",
      ],
      LEARNER: [
        "courses.browse",
        "cart.manage",
        "checkout.create",
        "orders.view",
        "reviews.create",
        "progress.update",
      ],
    };

    for (const roleName of roles) {
      await prisma.role.upsert({
        where: { name: roleName },
        update: {},
        create: { name: roleName },
      });
    }

    const allPermissions = Object.values(permissionsByRole).flat();
    for (const permissionName of allPermissions) {
      await prisma.permission.upsert({
        where: { name: permissionName },
        update: {},
        create: { name: permissionName },
      });
    }

    for (const roleName of roles) {
      const role = await prisma.role.findUnique({ where: { name: roleName } });
      for (const permissionName of permissionsByRole[roleName]) {
        const permission = await prisma.permission.findUnique({
          where: { name: permissionName },
        });

        await prisma.rolePermission.upsert({
          where: {
            roleId_permissionId: {
              roleId: role.id,
              permissionId: permission.id,
            },
          },
          update: {},
          create: {
            roleId: role.id,
            permissionId: permission.id,
          },
        });
      }
    }

    console.log("✅ Roles and permissions seeded");
  }
}
