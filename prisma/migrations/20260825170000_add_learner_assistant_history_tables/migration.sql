CREATE TABLE IF NOT EXISTS "learner_assistant_conversations" (
  "id" TEXT PRIMARY KEY,
  "user_id" TEXT NOT NULL,
  "title" TEXT,
  "state" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "learner_assistant_conversations_user_updated_idx"
ON "learner_assistant_conversations" ("user_id", "updated_at" DESC);

CREATE TABLE IF NOT EXISTS "learner_assistant_messages" (
  "id" BIGSERIAL PRIMARY KEY,
  "conversation_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "payload" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS "learner_assistant_messages_conversation_created_idx"
ON "learner_assistant_messages" ("conversation_id", "created_at" DESC);
