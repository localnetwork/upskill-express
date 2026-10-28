import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function loadOccupationData() {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const jsonPath = path.join(__dirname, "..", "data", "occupations.json");
  return JSON.parse(fs.readFileSync(jsonPath, "utf8"));
}

export default class OccupationSeeder {
  constructor() {
    this.weight = 32;
  }

  async run() {
    const data = loadOccupationData();

    for (const [categoryName, occupations] of Object.entries(data)) {
      const category = await prisma.category.findFirst({
        where: { name: categoryName, parentId: null, deletedAt: null },
      });
      if (!category) {
        console.warn(`Skipping occupations: category "${categoryName}" not found`);
        continue;
      }

      for (const name of occupations) {
        const existing = await prisma.occupation.findFirst({
          where: { name, categoryId: category.id },
        });
        if (existing) {
          if (existing.deletedAt) {
            await prisma.occupation.update({
              where: { id: existing.id },
              data: { deletedAt: null },
            });
          }
          continue;
        }

        const base = `${slugify(name)}-${slugify(category.slug)}`;
        let slug = base;
        let counter = 1;
        while (await prisma.occupation.findUnique({ where: { slug } })) {
          counter += 1;
          slug = `${base}-${counter}`;
        }

        await prisma.occupation.create({
          data: { name, slug, categoryId: category.id },
        });
      }
    }
  }
}
