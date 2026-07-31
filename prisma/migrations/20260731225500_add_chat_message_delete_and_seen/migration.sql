ALTER TABLE "chat_messages"
ADD COLUMN IF NOT EXISTS "deletedForEveryoneAt" TIMESTAMP(3),
ADD COLUMN IF NOT EXISTS "deletedForEveryoneById" TEXT;

CREATE INDEX IF NOT EXISTS "chat_messages_deletedForEveryoneAt_idx"
ON "chat_messages"("deletedForEveryoneAt");

CREATE TABLE IF NOT EXISTS "chat_message_hidden" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "chat_message_hidden_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "chat_message_hidden_messageId_userId_key"
ON "chat_message_hidden"("messageId", "userId");

CREATE INDEX IF NOT EXISTS "chat_message_hidden_userId_createdAt_idx"
ON "chat_message_hidden"("userId", "createdAt");

CREATE INDEX IF NOT EXISTS "chat_message_hidden_messageId_idx"
ON "chat_message_hidden"("messageId");

ALTER TABLE "chat_message_hidden"
ADD CONSTRAINT "chat_message_hidden_messageId_fkey"
FOREIGN KEY ("messageId") REFERENCES "chat_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "chat_message_hidden"
ADD CONSTRAINT "chat_message_hidden_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
