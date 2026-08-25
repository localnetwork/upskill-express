import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const CATEGORY_STYLE_RULES = [
  {
    icon: "Code2",
    color: "#2563EB",
    keywords: ["development", "programming", "software", "web", "mobile", "database", "testing", "it", "cloud"],
  },
  {
    icon: "BriefcaseBusiness",
    color: "#0F766E",
    keywords: ["business", "management", "entrepreneur", "operations", "sales", "e-commerce", "project"],
  },
  {
    icon: "Wallet",
    color: "#15803D",
    keywords: ["finance", "accounting", "money", "invest", "tax", "economics", "crypto", "blockchain"],
  },
  {
    icon: "SwatchBook",
    color: "#7C3AED",
    keywords: ["design", "ux", "ui", "illustration", "fashion", "architecture", "interior", "animation"],
  },
  {
    icon: "Megaphone",
    color: "#DB2777",
    keywords: ["marketing", "seo", "branding", "advertising", "content", "social media", "growth"],
  },
  {
    icon: "Dumbbell",
    color: "#DC2626",
    keywords: ["health", "fitness", "sports", "nutrition", "mental", "meditation", "yoga"],
  },
  {
    icon: "Camera",
    color: "#EA580C",
    keywords: ["photography", "video", "camera"],
  },
  {
    icon: "Music",
    color: "#7C2D12",
    keywords: ["music", "vocal", "instrument"],
  },
  {
    icon: "GraduationCap",
    color: "#1D4ED8",
    keywords: ["teaching", "academics", "education", "science", "math", "language", "learning"],
  },
  {
    icon: "HeartHandshake",
    color: "#C026D3",
    keywords: ["personal development", "lifestyle", "happiness", "relationships", "creativity"],
  },
];

const DEFAULT_CATEGORY_STYLE = { icon: "FolderOpen", color: "#334155" };

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

function resolveCategoryStyle(...values) {
  const haystack = values
    .map((value) => String(value || "").toLowerCase())
    .join(" ");

  for (const rule of CATEGORY_STYLE_RULES) {
    if (rule.keywords.some((keyword) => haystack.includes(keyword))) {
      return { icon: rule.icon, color: rule.color };
    }
  }

  return DEFAULT_CATEGORY_STYLE;
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
      const parentStyle = resolveCategoryStyle(parentTitle, parentCategory.description);
      if (!parent) {
        parent = await prisma.category.create({
          data: {
            name: parentTitle,
            slug: await uniqueSlug(parentTitle),
            icon: parentStyle.icon,
            color: parentStyle.color,
            deletedAt: null,
          },
        });
        console.log(`✅ Inserted parent category: ${parentTitle}`);
      } else if (parent.deletedAt) {
        parent = await prisma.category.update({
          where: { id: parent.id },
          data: {
            deletedAt: null,
            icon: parentStyle.icon,
            color: parentStyle.color,
          },
        });
        console.log(`♻️ Restored parent category: ${parentTitle}`);
      } else {
        await prisma.category.update({
          where: { id: parent.id },
          data: {
            icon: parentStyle.icon,
            color: parentStyle.color,
          },
        });
        console.log(`⚠️ Parent category exists: ${parentTitle}`);
      }

      for (const subTitle of parentCategory.subcategories || []) {
        const subcategoryStyle = resolveCategoryStyle(subTitle, parentTitle, parentCategory.description);
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
              icon: subcategoryStyle.icon,
              color: subcategoryStyle.color,
              deletedAt: null,
            },
          });
          console.log(`✅ Inserted subcategory: ${subTitle} (${parentTitle})`);
        } else if (existingChild.deletedAt) {
          await prisma.category.update({
            where: { id: existingChild.id },
            data: {
              deletedAt: null,
              icon: subcategoryStyle.icon,
              color: subcategoryStyle.color,
            },
          });
          console.log(`♻️ Restored subcategory: ${subTitle} (${parentTitle})`);
        } else {
          await prisma.category.update({
            where: { id: existingChild.id },
            data: {
              icon: subcategoryStyle.icon,
              color: subcategoryStyle.color,
            },
          });
          console.log(`⚠️ Subcategory exists: ${subTitle} (${parentTitle})`);
        }
      }
    }
  }
}
