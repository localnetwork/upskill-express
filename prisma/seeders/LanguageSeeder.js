import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function loadLanguageData() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const jsonPath = path.join(__dirname, "..", "data", "languages.json");

  const raw = fs.readFileSync(jsonPath, "utf8");
  return JSON.parse(raw);
}

export default class LanguageSeeder {
  constructor() {
    this.weight = 29;
  }

  async run() {
    const rows = loadLanguageData();
    const allLanguages = Array.from(
      new Set(
        rows.flatMap((row) =>
          Array.isArray(row?.languages)
            ? row.languages.map((item) => String(item || "").trim()).filter(Boolean)
            : []
        )
      )
    );

    await prisma.platformSetting.upsert({
      where: { key: "SUPPORTED_LANGUAGES" },
      update: {
        value: JSON.stringify(allLanguages),
        description: "Supported course languages list.",
      },
      create: {
        key: "SUPPORTED_LANGUAGES",
        value: JSON.stringify(allLanguages),
        description: "Supported course languages list.",
      },
    });

    await prisma.platformSetting.upsert({
      where: { key: "LANGUAGES_BY_COUNTRY" },
      update: {
        value: JSON.stringify(rows),
        description: "Language options grouped by country.",
      },
      create: {
        key: "LANGUAGES_BY_COUNTRY",
        value: JSON.stringify(rows),
        description: "Language options grouped by country.",
      },
    });

    console.log(`✅ Upserted languages (${allLanguages.length})`);
  }
}