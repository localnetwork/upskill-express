DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'DiscussionCategory') THEN
    CREATE TYPE "DiscussionCategory" AS ENUM ('COURSE_CONTENT', 'SOMETHING_ELSE');
  END IF;
END $$;

ALTER TABLE "discussion_threads"
ADD COLUMN IF NOT EXISTS "category" "DiscussionCategory" NOT NULL DEFAULT 'COURSE_CONTENT';

CREATE TABLE IF NOT EXISTS "discussion_thread_votes" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "voterId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "discussion_thread_votes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "discussion_thread_votes_threadId_voterId_key"
ON "discussion_thread_votes"("threadId", "voterId");

CREATE INDEX IF NOT EXISTS "discussion_thread_votes_voterId_createdAt_idx"
ON "discussion_thread_votes"("voterId", "createdAt");

ALTER TABLE "discussion_thread_votes"
ADD CONSTRAINT "discussion_thread_votes_threadId_fkey"
FOREIGN KEY ("threadId") REFERENCES "discussion_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "discussion_thread_votes"
ADD CONSTRAINT "discussion_thread_votes_voterId_fkey"
FOREIGN KEY ("voterId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
