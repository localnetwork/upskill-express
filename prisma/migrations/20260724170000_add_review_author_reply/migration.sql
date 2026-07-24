-- AlterTable
ALTER TABLE "reviews"
ADD COLUMN "authorReply" TEXT,
ADD COLUMN "authorReplyAt" TIMESTAMP(3);
