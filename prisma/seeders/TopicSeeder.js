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

async function uniqueTopicSlug(name, categorySlug = "") {
  const base = slugify(name);
  const suffix = categorySlug ? `-${slugify(categorySlug)}` : "";
  let candidate = `${base}${suffix}`;
  let counter = 1;

  while (await prisma.topic.findUnique({ where: { slug: candidate } })) {
    counter += 1;
    candidate = `${base}${suffix}-${counter}`;
  }

  return candidate;
}

async function uniqueCategorySlug(name, parentTitle = "") {
  const base = slugify(name);
  const suffix = parentTitle ? `-${slugify(parentTitle)}` : "";
  let candidate = `${base}${suffix}`;
  let counter = 1;

  while (await prisma.category.findUnique({ where: { slug: candidate } })) {
    counter += 1;
    candidate = `${base}${suffix}-${counter}`;
  }

  return candidate;
}

function loadTopicData() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);

  const rootDataPath = path.join(__dirname, "..", "..", "data", "topics.json");
  const prismaDataPath = path.join(__dirname, "..", "data", "topics.json");
  const dataPath = fs.existsSync(rootDataPath) ? rootDataPath : prismaDataPath;

  if (!fs.existsSync(dataPath)) {
    throw new Error(`topics.json not found. Expected at: ${rootDataPath} or ${prismaDataPath}`);
  }

  const raw = fs.readFileSync(dataPath, "utf8");
  return JSON.parse(raw);
}

async function ensureCategory(name, parentId = null, parentTitle = "") {
  const normalizedName = String(name || "").trim();
  if (!normalizedName) return null;

  const existing = await prisma.category.findFirst({
    where: { name: normalizedName, parentId },
  });

  if (!existing) {
    return prisma.category.create({
      data: {
        name: normalizedName,
        parentId,
        slug: await uniqueCategorySlug(normalizedName, parentTitle),
        deletedAt: null,
      },
    });
  }

  if (existing.deletedAt) {
    return prisma.category.update({
      where: { id: existing.id },
      data: { deletedAt: null },
    });
  }

  return existing;
}

export default class TopicSeeder {
  constructor() {
    this.weight = 31;
  }

  async run() {
    const topicMappings = loadTopicData();

    for (const categoryEntry of topicMappings) {
      const parentTitle = String(categoryEntry?.category || categoryEntry?.title || "").trim();
      if (!parentTitle) continue;

      const parent = await ensureCategory(parentTitle, null, "");
      if (!parent) continue;

      for (const subcategoryEntry of categoryEntry?.subcategories || []) {
        const subcategoryTitle = String(
          subcategoryEntry?.title || subcategoryEntry?.subcategory || ""
        ).trim();
        if (!subcategoryTitle) continue;

        const subcategory = await ensureCategory(subcategoryTitle, parent.id, parentTitle);
        if (!subcategory) continue;

        for (const topicNameRaw of subcategoryEntry?.topics || []) {
          const topicName = String(topicNameRaw || "").trim();
          if (!topicName) continue;

          const existingTopic = await prisma.topic.findFirst({
            where: {
              name: topicName,
              categoryId: subcategory.id,
            },
          });

          if (!existingTopic) {
            await prisma.topic.create({
              data: {
                name: topicName,
                categoryId: subcategory.id,
                slug: await uniqueTopicSlug(topicName, subcategory.slug),
                deletedAt: null,
              },
            });
            continue;
          }

          if (existingTopic.deletedAt) {
            await prisma.topic.update({
              where: { id: existingTopic.id },
              data: { deletedAt: null },
            });
          }
        }
      }
    }
  }
}
