-- Allow custom roles: role name becomes free text, and default roles are flagged as system roles.
ALTER TABLE "roles" ALTER COLUMN "name" TYPE TEXT USING "name"::text;
ALTER TABLE "roles" ADD COLUMN "description" TEXT;
ALTER TABLE "roles" ADD COLUMN "isSystem" BOOLEAN NOT NULL DEFAULT false;

UPDATE "roles" SET "isSystem" = true WHERE "name" IN ('ADMIN', 'EDUCATOR', 'LEARNER');
