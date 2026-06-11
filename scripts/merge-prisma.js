import fs from "fs";
import { globSync } from "glob";

const schemaPath = "prisma/schema.prisma";

const header = `generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}`;

function extractBlocks(content, keyword) {
  const blocks = [];
  const lines = content.split("\n");
  let current = [];
  let insideBlock = false;
  let braceDepth = 0;

  for (const line of lines) {
    if (!insideBlock && new RegExp(`^${keyword}\\s+\\w+\\s*\\{`).test(line.trim())) {
      insideBlock = true;
      braceDepth = 0;
      current = [];
    }

    if (!insideBlock) {
      continue;
    }

    current.push(line);
    braceDepth += (line.match(/\{/g) || []).length;
    braceDepth -= (line.match(/\}/g) || []).length;

    if (braceDepth === 0) {
      const block = current.join("\n").trim();
      const match = block.match(new RegExp(`^${keyword}\\s+(\\w+)`));
      if (match) {
        blocks.push({ name: match[1], content: block });
      }
      insideBlock = false;
      current = [];
    }
  }

  return blocks;
}

const enumFiles = globSync("prisma/enums/**/*.prisma").sort();
const modelFiles = globSync("prisma/models/**/*.prisma").sort();

const enumMap = new Map();
const modelMap = new Map();

for (const file of enumFiles) {
  const content = fs.readFileSync(file, "utf8");
  for (const block of extractBlocks(content, "enum")) {
    enumMap.set(block.name, block.content);
  }
}

for (const file of modelFiles) {
  const content = fs.readFileSync(file, "utf8");
  for (const block of extractBlocks(content, "model")) {
    modelMap.set(block.name, block.content);
  }
}

const enums = Array.from(enumMap.values()).join("\n\n");
const models = Array.from(modelMap.values()).join("\n\n");

const finalSchema = `${header}\n\n${enums}\n\n${models}\n`;
fs.writeFileSync(schemaPath, finalSchema);

console.log(
  `✅ schema.prisma rebuilt with ${enumMap.size} enums and ${modelMap.size} models`,
);
