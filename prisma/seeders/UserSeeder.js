import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

export default class UserSeeder {
  constructor() {
    this.weight = 15;
  }

  async run() {
    const users = [
      {
        username: "admin",
        email: "admin@upskill.local",
        firstName: "Platform",
        lastName: "Admin",
        passwordHash:
          "$2b$10$h8yWPMN5pO2J5qYfQjVG0O8w9o4fL5vG3OW0H0j3xp4xgShh7LwJm",
        role: "ADMIN",
      },
      {
        username: "learner",
        email: "learner@upskill.local",
        firstName: "Default",
        lastName: "Learner",
        passwordHash:
          "$2b$10$h8yWPMN5pO2J5qYfQjVG0O8w9o4fL5vG3OW0H0j3xp4xgShh7LwJm",
        role: "LEARNER",
      },
      {
        username: "educator",
        email: "educator@upskill.local",
        firstName: "Default",
        lastName: "Educator",
        passwordHash:
          "$2b$10$h8yWPMN5pO2J5qYfQjVG0O8w9o4fL5vG3OW0H0j3xp4xgShh7LwJm",
        role: "EDUCATOR",
      },
    ];

    for (const userData of users) {
      const role = await prisma.role.findUnique({
        where: { name: userData.role },
      });

      if (!role) {
        console.log(`⚠️ Role missing for user ${userData.email}: ${userData.role}`);
        continue;
      }

      const { role: roleName, ...createData } = userData;

      const user = await prisma.user.upsert({
        where: { email: userData.email },
        update: {
          ...createData,
          isActive: true,
        },
        create: {
          ...createData,
          isActive: true,
        },
      });

      await prisma.userRole.upsert({
        where: {
          userId_roleId: {
            userId: user.id,
            roleId: role.id,
          },
        },
        update: {},
        create: {
          userId: user.id,
          roleId: role.id,
        },
      });

      console.log(`✅ Upserted: ${user.email} with role ${roleName}`);
    }
  }
}
