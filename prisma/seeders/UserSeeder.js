import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";
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
        password: "Admin@12345",
        role: "ADMIN",
      },
      {
        username: "learner",
        email: "learner@upskill.local",
        firstName: "Default",
        lastName: "Learner",
        password: "Learner@12345",
        role: "LEARNER",
      },
      {
        username: "educator",
        email: "educator@upskill.local",
        firstName: "Default",
        lastName: "Educator",
        password: "Educator@12345",
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

      const { role: roleName, password, ...baseData } = userData;
      const passwordHash = await bcrypt.hash(password, 10);
      const createData = {
        ...baseData,
        passwordHash,
      };

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

      console.log(
        `✅ Upserted: ${user.email} with role ${roleName} (password: ${password})`,
      );
    }
  }
}
