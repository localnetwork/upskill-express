-- CreateEnum
CREATE TYPE "ChatMessageType" AS ENUM ('USER', 'SYSTEM');

-- AlterTable
ALTER TABLE "chat_conversation_participants" ADD COLUMN     "backgroundMediaId" TEXT,
ADD COLUMN     "nickname" TEXT,
ADD COLUMN     "photoMediaId" TEXT;

-- AlterTable
ALTER TABLE "chat_messages" ADD COLUMN     "messageType" "ChatMessageType" NOT NULL DEFAULT 'USER',
ADD COLUMN     "metadata" JSONB;
