CREATE TABLE "lesson_video_uploads" (
    "id" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "providerVideoId" TEXT NOT NULL,
    "uploadUrl" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'video/mp4',
    "sizeInBytes" BIGINT NOT NULL,
    "durationInSeconds" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lesson_video_uploads_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "lesson_video_uploads_lessonId_key" ON "lesson_video_uploads"("lessonId");

ALTER TABLE "lesson_video_uploads" ADD CONSTRAINT "lesson_video_uploads_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "lessons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
