-- CreateEnum
CREATE TYPE "LessonUnlockType" AS ENUM ('IMMEDIATE', 'DATE', 'AFTER_PREVIOUS', 'AFTER_CUSTOM');

-- AlterTable
ALTER TABLE "lessons"
ADD COLUMN "unlockType" "LessonUnlockType" NOT NULL DEFAULT 'IMMEDIATE',
ADD COLUMN "unlockAt" TIMESTAMP(3),
ADD COLUMN "prerequisiteLessonId" TEXT;

-- AlterTable
ALTER TABLE "enrollments"
ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- CreateTable
CREATE TABLE "course_nudge_rules" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "educatorId" TEXT NOT NULL,
    "inactivityDaysThreshold" INTEGER NOT NULL DEFAULT 7,
    "lowProgressThreshold" INTEGER NOT NULL DEFAULT 50,
    "enabledInactivityNudge" BOOLEAN NOT NULL DEFAULT true,
    "enabledLowProgressNudge" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "course_nudge_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "course_nudge_logs" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "enrollmentId" TEXT,
    "learnerId" TEXT NOT NULL,
    "sentById" TEXT,
    "triggerType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SENT',
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "course_nudge_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discussion_threads" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "isResolved" BOOLEAN NOT NULL DEFAULT false,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "discussion_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "discussion_replies" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "parentReplyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "discussion_replies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "lessons_prerequisiteLessonId_idx" ON "lessons"("prerequisiteLessonId");
CREATE INDEX "course_nudge_rules_educatorId_idx" ON "course_nudge_rules"("educatorId");
CREATE UNIQUE INDEX "course_nudge_rules_courseId_key" ON "course_nudge_rules"("courseId");
CREATE INDEX "course_nudge_logs_courseId_triggerType_sentAt_idx" ON "course_nudge_logs"("courseId", "triggerType", "sentAt");
CREATE INDEX "course_nudge_logs_learnerId_sentAt_idx" ON "course_nudge_logs"("learnerId", "sentAt");
CREATE INDEX "course_nudge_logs_enrollmentId_idx" ON "course_nudge_logs"("enrollmentId");
CREATE INDEX "discussion_threads_courseId_lessonId_createdAt_idx" ON "discussion_threads"("courseId", "lessonId", "createdAt");
CREATE INDEX "discussion_threads_authorId_createdAt_idx" ON "discussion_threads"("authorId", "createdAt");
CREATE INDEX "discussion_threads_resolvedById_idx" ON "discussion_threads"("resolvedById");
CREATE INDEX "discussion_replies_threadId_createdAt_idx" ON "discussion_replies"("threadId", "createdAt");
CREATE INDEX "discussion_replies_authorId_createdAt_idx" ON "discussion_replies"("authorId", "createdAt");
CREATE INDEX "discussion_replies_parentReplyId_idx" ON "discussion_replies"("parentReplyId");

-- AddForeignKey
ALTER TABLE "lessons"
ADD CONSTRAINT "lessons_prerequisiteLessonId_fkey"
FOREIGN KEY ("prerequisiteLessonId") REFERENCES "lessons"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "course_nudge_rules"
ADD CONSTRAINT "course_nudge_rules_courseId_fkey"
FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "course_nudge_rules"
ADD CONSTRAINT "course_nudge_rules_educatorId_fkey"
FOREIGN KEY ("educatorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "course_nudge_logs"
ADD CONSTRAINT "course_nudge_logs_courseId_fkey"
FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "course_nudge_logs"
ADD CONSTRAINT "course_nudge_logs_enrollmentId_fkey"
FOREIGN KEY ("enrollmentId") REFERENCES "enrollments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "course_nudge_logs"
ADD CONSTRAINT "course_nudge_logs_learnerId_fkey"
FOREIGN KEY ("learnerId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "course_nudge_logs"
ADD CONSTRAINT "course_nudge_logs_sentById_fkey"
FOREIGN KEY ("sentById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "discussion_threads"
ADD CONSTRAINT "discussion_threads_courseId_fkey"
FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "discussion_threads"
ADD CONSTRAINT "discussion_threads_lessonId_fkey"
FOREIGN KEY ("lessonId") REFERENCES "lessons"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "discussion_threads"
ADD CONSTRAINT "discussion_threads_authorId_fkey"
FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "discussion_threads"
ADD CONSTRAINT "discussion_threads_resolvedById_fkey"
FOREIGN KEY ("resolvedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "discussion_replies"
ADD CONSTRAINT "discussion_replies_threadId_fkey"
FOREIGN KEY ("threadId") REFERENCES "discussion_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "discussion_replies"
ADD CONSTRAINT "discussion_replies_authorId_fkey"
FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "discussion_replies"
ADD CONSTRAINT "discussion_replies_parentReplyId_fkey"
FOREIGN KEY ("parentReplyId") REFERENCES "discussion_replies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
