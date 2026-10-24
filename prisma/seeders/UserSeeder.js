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
      {
        username: "finance",
        email: "finance@upskill.local",
        firstName: "Finance",
        lastName: "Officer",
        password: "Finance@12345",
        role: "FINANCE_OFFICER",
      },
      {
        username: "reviewer",
        email: "reviewer@upskill.local",
        firstName: "Course",
        lastName: "Reviewer",
        password: "Reviewer@12345",
        role: "COURSE_REVIEWER",
      },
      {
        username: "support",
        email: "support@upskill.local",
        firstName: "Support",
        lastName: "Agent",
        password: "Support@12345",
        role: "SUPPORT_AGENT",
      },
      {
        username: "analyst",
        email: "analyst@upskill.local",
        firstName: "Data",
        lastName: "Analyst",
        password: "Analyst@12345",
        role: "ANALYST",
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
