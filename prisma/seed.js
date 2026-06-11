import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { fileURLToPath } from "url";

async function runSeeders() {
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = path.dirname(__filename);
  const seedersPath = path.join(__dirname, "seeders");

  const files = fs
    .readdirSync(seedersPath)
    .filter((file) => file.endsWith(".js"));

  const seeders = [];

  for (const file of files) {
    const fullPath = path.join(seedersPath, file);
    const mod = await import(pathToFileURL(fullPath).href);
    const SeederClass = mod.default;

    if (typeof SeederClass !== "function") {
      throw new Error(`Seeder invalid export in: ${file}`);
    }

    seeders.push(new SeederClass());
  }

  seeders.sort((a, b) => a.weight - b.weight);
  let failed = 0;

  for (const seeder of seeders) {
    console.log(`\n🌱 Running: ${seeder.constructor.name}`);

    try {
      await seeder.run();
    } catch (err) {
      failed += 1;
      console.error(`❌ Failed seeder: ${seeder.constructor.name}`);
      console.error(err);
    }
  }

  if (failed > 0) {
    throw new Error(`${failed} seeder(s) failed`);
  }

  console.log("\n✅ All seeders completed");
}

runSeeders().catch((err) => {
  console.error("Seeder crash:", err);
  process.exit(1);
});
