import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

export default class CoursePriceTierSeeder {
  constructor() {
    this.weight = 25;
  }

  async run() {
    const tiers = [
      { title: "Free", price: 0.0 },
      { title: "Tier 1", price: 50.0 },
      { title: "Tier 2", price: 100.0 },
      { title: "Tier 3", price: 200.0 },
      { title: "Tier 4", price: 250.0 },
      { title: "Tier 5", price: 300.0 },
      { title: "Tier 6", price: 400.0 },
      { title: "Tier 7", price: 500.0 },
    ];

    for (const tier of tiers) {
      await prisma.coursePriceTier.upsert({
        where: { title: tier.title },
        update: { price: tier.price },
        create: tier,
      });
      console.log(`✅ Upserted tier: ${tier.title} ($${tier.price.toFixed(2)})`);
    }
  }
}
