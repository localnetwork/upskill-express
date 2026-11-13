-- CreateTable
CREATE TABLE "role_play_attempts" (
    "id" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'text',
    "transcript" JSONB NOT NULL,
    "report" JSONB,
    "durationInSeconds" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_play_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "role_play_attempts_lessonId_userId_idx" ON "role_play_attempts"("lessonId", "userId");

-- AddForeignKey
ALTER TABLE "role_play_attempts" ADD CONSTRAINT "role_play_attempts_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "lessons"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_play_attempts" ADD CONSTRAINT "role_play_attempts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
