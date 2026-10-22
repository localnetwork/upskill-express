import { PrismaClient } from "@prisma/client";
import { withAccelerate } from "@prisma/extension-accelerate";

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

// Prisma's default pool is (cpu * 2 + 1) connections; cap it explicitly so the
// app can't exhaust the hosted database, and wait longer before timing out.
function withPoolParams(url) {
  if (!url) return url;
  const parsed = new URL(url);
  if (!parsed.searchParams.has("connection_limit")) {
    parsed.searchParams.set(
      "connection_limit",
      process.env.PRISMA_CONNECTION_LIMIT || "10",
    );
  }
  if (!parsed.searchParams.has("pool_timeout")) {
    parsed.searchParams.set(
      "pool_timeout",
      process.env.PRISMA_POOL_TIMEOUT || "30",
    );
  }
  return parsed.toString();
}

const globalForPrisma = globalThis;

export const prisma =
  globalForPrisma.prisma ||
  new PrismaClient({
    datasourceUrl: withPoolParams(process.env.DATABASE_URL),
    log: ["error", "warn"],
  }).$extends(withAccelerate());

// Reuse one client across nodemon/hot reloads and in production too.
globalForPrisma.prisma = prisma;
