import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

export default class CourseLevelSeeder {
  constructor() {
    this.weight = 20;
  }

  async run() {
    const levels = [
      { title: "Beginner", weight: 1 },
      { title: "Intermediate", weight: 2 },
      { title: "Advanced", weight: 3 },
    ];

    for (const level of levels) {
      const exists = await prisma.courseLevel.findFirst({
        where: { title: level.title },
      });

      if (exists) {
        console.log(`⚠️ Skipped: ${level.title}`);
        continue;
      }

      await prisma.courseLevel.create({ data: level });

      console.log(`✅ Inserted: ${level.title}`);
    }
  }
}
