-- AlterTable
ALTER TABLE "users" ADD COLUMN "passwordSet" BOOLEAN NOT NULL DEFAULT true;

-- Accounts created through Google sign-in have a random, unknown password.
UPDATE "users"
SET "passwordSet" = false
WHERE "id" IN (
  SELECT "userId"
  FROM "activity_events"
  WHERE "eventType"::text = 'AUTH_REGISTER'
    AND "userId" IS NOT NULL
    AND "metadata"->>'provider' = 'google'
);
