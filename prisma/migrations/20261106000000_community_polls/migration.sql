-- AlterTable
ALTER TABLE "community_posts" ADD COLUMN "isPoll" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "pollEndsAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "community_poll_options" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "community_poll_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "community_poll_votes" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "community_poll_votes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "community_poll_options_postId_position_idx" ON "community_poll_options"("postId", "position");

-- CreateIndex
CREATE INDEX "community_poll_votes_optionId_idx" ON "community_poll_votes"("optionId");

-- CreateIndex
CREATE UNIQUE INDEX "community_poll_votes_postId_userId_key" ON "community_poll_votes"("postId", "userId");

-- AddForeignKey
ALTER TABLE "community_poll_options" ADD CONSTRAINT "community_poll_options_postId_fkey" FOREIGN KEY ("postId") REFERENCES "community_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_poll_votes" ADD CONSTRAINT "community_poll_votes_postId_fkey" FOREIGN KEY ("postId") REFERENCES "community_posts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "community_poll_votes" ADD CONSTRAINT "community_poll_votes_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "community_poll_options"("id") ON DELETE CASCADE ON UPDATE CASCADE;
