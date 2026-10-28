-- AlterTable
ALTER TABLE "users" ADD COLUMN     "occupationCustom" TEXT,
ADD COLUMN     "occupationId" TEXT;

-- CreateTable
CREATE TABLE "occupations" (
    "id" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "occupations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_interests" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "topicId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_interests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "occupations_slug_key" ON "occupations"("slug");

-- CreateIndex
CREATE INDEX "occupations_categoryId_idx" ON "occupations"("categoryId");

-- CreateIndex
CREATE INDEX "occupations_deletedAt_idx" ON "occupations"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "occupations_name_categoryId_key" ON "occupations"("name", "categoryId");

-- CreateIndex
CREATE INDEX "user_interests_topicId_idx" ON "user_interests"("topicId");

-- CreateIndex
CREATE UNIQUE INDEX "user_interests_userId_topicId_key" ON "user_interests"("userId", "topicId");

-- CreateIndex
CREATE INDEX "users_occupationId_idx" ON "users"("occupationId");

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_occupationId_fkey" FOREIGN KEY ("occupationId") REFERENCES "occupations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "occupations" ADD CONSTRAINT "occupations_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "categories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_interests" ADD CONSTRAINT "user_interests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_interests" ADD CONSTRAINT "user_interests_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "topics"("id") ON DELETE CASCADE ON UPDATE CASCADE;

