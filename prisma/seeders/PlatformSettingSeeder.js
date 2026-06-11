import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

export default class PlatformSettingSeeder {
  constructor() {
    this.weight = 30;
  }

  async run() {
    const settings = [
      {
        key: "PLATFORM_FEE_PERCENT",
        value: "20",
        description: "Platform fee percentage used for revenue sharing.",
      },
      {
        key: "DEFAULT_CURRENCY",
        value: "USD",
        description: "Default storefront currency.",
      },
    ];

    for (const setting of settings) {
      await prisma.platformSetting.upsert({
        where: { key: setting.key },
        update: {
          value: setting.value,
          description: setting.description,
        },
        create: setting,
      });
      console.log(`✅ Upserted setting: ${setting.key}`);
    }
  }
}
