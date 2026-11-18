CREATE TABLE "assignment_submissions" (
    "id" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "answers" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "submittedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assignment_submissions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "assignment_submissions_lessonId_userId_key" ON "assignment_submissions"("lessonId", "userId");

CREATE INDEX "assignment_submissions_userId_idx" ON "assignment_submissions"("userId");
