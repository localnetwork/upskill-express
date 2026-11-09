-- AlterEnum
ALTER TYPE "CourseWorkflowStatus" ADD VALUE 'SUSPENDED';

-- AlterTable
ALTER TABLE "courses" ADD COLUMN     "suspendedAt" TIMESTAMP(3),
ADD COLUMN     "suspendedById" TEXT,
ADD COLUMN     "suspendedReason" TEXT;
