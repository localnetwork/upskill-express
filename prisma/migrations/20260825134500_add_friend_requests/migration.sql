DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type
    WHERE typname = 'FriendRequestStatus'
  ) THEN
    CREATE TYPE "FriendRequestStatus" AS ENUM (
      'PENDING',
      'ACCEPTED',
      'DECLINED',
      'CANCELED'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "friend_requests" (
  "id" TEXT NOT NULL,
  "requesterId" TEXT NOT NULL,
  "addresseeId" TEXT NOT NULL,
  "userAId" TEXT NOT NULL,
  "userBId" TEXT NOT NULL,
  "status" "FriendRequestStatus" NOT NULL DEFAULT 'PENDING',
  "respondedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "friend_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "friend_requests_userAId_userBId_key"
  ON "friend_requests"("userAId", "userBId");

CREATE INDEX IF NOT EXISTS "friend_requests_requesterId_status_createdAt_idx"
  ON "friend_requests"("requesterId", "status", "createdAt");

CREATE INDEX IF NOT EXISTS "friend_requests_addresseeId_status_createdAt_idx"
  ON "friend_requests"("addresseeId", "status", "createdAt");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'friend_requests_requesterId_fkey'
  ) THEN
    ALTER TABLE "friend_requests"
    ADD CONSTRAINT "friend_requests_requesterId_fkey"
    FOREIGN KEY ("requesterId")
    REFERENCES "users"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'friend_requests_addresseeId_fkey'
  ) THEN
    ALTER TABLE "friend_requests"
    ADD CONSTRAINT "friend_requests_addresseeId_fkey"
    FOREIGN KEY ("addresseeId")
    REFERENCES "users"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;
  END IF;
END $$;
