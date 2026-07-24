-- CreateTable
CREATE TABLE "topics" (
  "id" TEXT NOT NULL,
  "categoryId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "description" TEXT,
  "deletedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "topics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "topics_slug_key" ON "topics"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "topics_name_categoryId_key" ON "topics"("name", "categoryId");

-- CreateIndex
CREATE INDEX "topics_categoryId_idx" ON "topics"("categoryId");

-- CreateIndex
CREATE INDEX "topics_deletedAt_idx" ON "topics"("deletedAt");

-- AddColumn
ALTER TABLE "lessons"
ADD COLUMN "topicId" TEXT;

-- CreateIndex
CREATE INDEX "lessons_topicId_idx" ON "lessons"("topicId");

-- AddForeignKey
ALTER TABLE "topics"
ADD CONSTRAINT "topics_categoryId_fkey"
FOREIGN KEY ("categoryId") REFERENCES "categories"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lessons"
ADD CONSTRAINT "lessons_topicId_fkey"
FOREIGN KEY ("topicId") REFERENCES "topics"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
