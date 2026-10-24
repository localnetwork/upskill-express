import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

// PayPal billing plans are linked later; subscribe stays "Coming soon" until paypalPlanId is set.
export default class PlanSeeder {
  constructor() {
    this.weight = 60;
  }

  async run() {
    const plans = [
      { name: "Monthly", interval: "MONTH", price: 300 },
      // 30% off the first year, then the regular yearly price
      { name: "Annual", interval: "YEAR", price: 3600, firstCyclePrice: 2520 },
    ];

    for (const plan of plans) {
      const exists = await prisma.plan.findFirst({
        where: { name: plan.name, interval: plan.interval },
      });
      if (exists) {
        console.log(`Skipped: ${plan.name}`);
        continue;
      }
      await prisma.plan.create({ data: { ...plan, currency: "PHP" } });
      console.log(`Inserted: ${plan.name}`);
    }
  }
}
