/*
  Warnings:

  - You are about to drop the `learner_assistant_conversations` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `learner_assistant_messages` table. If the table is not empty, all the data it contains will be lost.

*/
-- AlterTable
ALTER TABLE "community_comments" ADD COLUMN     "mediaIndex" INTEGER,
ADD COLUMN     "parentId" TEXT;

-- AlterTable
ALTER TABLE "community_members" ADD COLUMN     "bannedUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "community_posts" ADD COLUMN     "imageUrls" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- DropTable
DROP TABLE "learner_assistant_conversations";

-- DropTable
DROP TABLE "learner_assistant_messages";

-- CreateIndex
CREATE INDEX "community_comments_parentId_idx" ON "community_comments"("parentId");

-- AddForeignKey
ALTER TABLE "community_comments" ADD CONSTRAINT "community_comments_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "community_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
