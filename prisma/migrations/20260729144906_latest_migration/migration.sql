-- DropIndex
DROP INDEX "trusted_devices_userId_revokedAt_expiresAt_idx";

-- AlterTable
ALTER TABLE "lesson_topics" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "topics" ALTER COLUMN "updatedAt" DROP DEFAULT;
