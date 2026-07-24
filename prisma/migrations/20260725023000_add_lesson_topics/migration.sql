-- CreateTable
CREATE TABLE "lesson_topics" (
  "id" TEXT NOT NULL,
  "lessonId" TEXT NOT NULL,
  "topicId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "lesson_topics_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lesson_topics_lessonId_topicId_key"
ON "lesson_topics"("lessonId", "topicId");

-- CreateIndex
CREATE INDEX "lesson_topics_lessonId_idx"
ON "lesson_topics"("lessonId");

-- CreateIndex
CREATE INDEX "lesson_topics_topicId_idx"
ON "lesson_topics"("topicId");

-- AddForeignKey
ALTER TABLE "lesson_topics"
ADD CONSTRAINT "lesson_topics_lessonId_fkey"
FOREIGN KEY ("lessonId") REFERENCES "lessons"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lesson_topics"
ADD CONSTRAINT "lesson_topics_topicId_fkey"
FOREIGN KEY ("topicId") REFERENCES "topics"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
