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

async function uniqueSlug(title, parentTitle = "") {
  const base = slugify(title);
  const parentSuffix = parentTitle ? `-${slugify(parentTitle)}` : "";
  let candidate = base;
  let counter = 1;

  while (await prisma.category.findUnique({ where: { slug: candidate } })) {
    counter += 1;
    candidate = `${base}${parentSuffix}-${counter}`;
  }

  return candidate;
}

function loadCategoryData() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const jsonPath = path.join(__dirname, "..", "data", "categories.json");
  const raw = fs.readFileSync(jsonPath, "utf8");
  return JSON.parse(raw);
}

export default class CategorySeeder {
  constructor() {
    this.weight = 30;
  }

  async run() {
    const categories = loadCategoryData();

    for (const parentCategory of categories) {
      const parentTitle = parentCategory.title;
      const existingParent = await prisma.category.findFirst({
        where: {
          name: parentTitle,
          parentId: null,
        },
      });

      let parent = existingParent;
      if (!parent) {
        parent = await prisma.category.create({
          data: {
            name: parentTitle,
            slug: await uniqueSlug(parentTitle),
            deletedAt: null,
          },
        });
        console.log(`✅ Inserted parent category: ${parentTitle}`);
      } else if (parent.deletedAt) {
        parent = await prisma.category.update({
          where: { id: parent.id },
          data: { deletedAt: null },
        });
        console.log(`♻️ Restored parent category: ${parentTitle}`);
      } else {
        console.log(`⚠️ Parent category exists: ${parentTitle}`);
      }

      for (const subTitle of parentCategory.subcategories || []) {
        const existingChild = await prisma.category.findFirst({
          where: {
            name: subTitle,
            parentId: parent.id,
          },
        });

        if (!existingChild) {
          await prisma.category.create({
            data: {
              name: subTitle,
              parentId: parent.id,
              slug: await uniqueSlug(subTitle, parentTitle),
              deletedAt: null,
            },
          });
          console.log(`✅ Inserted subcategory: ${subTitle} (${parentTitle})`);
        } else if (existingChild.deletedAt) {
          await prisma.category.update({
            where: { id: existingChild.id },
            data: { deletedAt: null },
          });
          console.log(`♻️ Restored subcategory: ${subTitle} (${parentTitle})`);
        } else {
          console.log(`⚠️ Subcategory exists: ${subTitle} (${parentTitle})`);
        }
      }
    }
  }
}
