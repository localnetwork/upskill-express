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
        email: "admin@upskill.local",        fullName: "Platform Admin",
        role: "ADMIN",
      },
      {
        username: "learner",
        email: "learner@upskill.local",        fullName: "Default Learner",
        role: "LEARNER",
      },
      {
        username: "educator",
        email: "educator@upskill.local",        fullName: "Default Educator",
        role: "EDUCATOR",
      },
      {
        username: "finance",
        email: "finance@upskill.local",        fullName: "Finance Officer",
        role: "FINANCE_OFFICER",
      },
      {
        username: "reviewer",
        email: "reviewer@upskill.local",        fullName: "Course Reviewer",
        role: "COURSE_REVIEWER",
      },
      {
        username: "support",
        email: "support@upskill.local",        fullName: "Support Agent",
        role: "SUPPORT_AGENT",
      },
      {
        username: "analyst",
        email: "analyst@upskill.local",        fullName: "Data Analyst",
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

      const { role: roleName, ...baseData } = userData;
      const createData = {
        ...baseData,
        emailVerifiedAt: new Date(),
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
        `✅ Upserted: ${user.email} with role ${roleName}`,
      );
    }
  }
}
