CREATE TABLE "review_likes" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "review_likes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "review_likes_reviewId_userId_key" ON "review_likes"("reviewId", "userId");
CREATE INDEX "review_likes_userId_createdAt_idx" ON "review_likes"("userId", "createdAt");

ALTER TABLE "review_likes"
ADD CONSTRAINT "review_likes_reviewId_fkey"
FOREIGN KEY ("reviewId") REFERENCES "reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "review_likes"
ADD CONSTRAINT "review_likes_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
