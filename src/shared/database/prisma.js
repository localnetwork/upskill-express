import { PrismaClient } from "@prisma/client";

/**
 * Validates database configuration and logs warnings for common issues
 * when using Prisma behind PgBouncer (e.g. Neon).
 */
function validateDatabaseConfig() {
  const url = process.env.DATABASE_URL;

  if (!url) {
    console.warn("[prisma] WARNING: DATABASE_URL is not set");
    return;
  }

  if (!url.includes("pgbouncer=true")) {
    console.warn(
      "[prisma] WARNING: DATABASE_URL is missing pgbouncer=true — Neon requires this parameter behind PgBouncer"
    );
  }

  const match = url.match(/connection_limit=(\d+)/);
  if (match) {
    const limit = parseInt(match[1], 10);
    if (limit > 5) {
      console.warn(
        `[prisma] WARNING: connection_limit=${limit} is large for a pooled connection. Consider lowering it to 5 or less.`
      );
    }
  } else {
    console.warn(
      "[prisma] WARNING: connection_limit not set in DATABASE_URL. Behind PgBouncer, set it to 3 or less."
    );
  }
}

validateDatabaseConfig();

const globalForPrisma = globalThis;

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    log: ["error", "warn"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
