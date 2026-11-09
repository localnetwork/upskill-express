-- AlterTable: replace first/last name with a single full name
ALTER TABLE "users" ADD COLUMN "fullName" TEXT;

UPDATE "users"
SET "fullName" = NULLIF(BTRIM(CONCAT_WS(' ', "firstName", "lastName")), '');

ALTER TABLE "users" DROP COLUMN "firstName",
DROP COLUMN "lastName";

-- AlterTable: authentication is passwordless (email one-time codes / 2FA)
ALTER TABLE "users" DROP COLUMN "passwordHash",
DROP COLUMN "passwordSet",
DROP COLUMN "verificationToken",
DROP COLUMN "resetPasswordToken",
DROP COLUMN "resetPasswordTokenExp";

-- CreateTable
CREATE TABLE "auth_otps" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "userId" TEXT,
    "codeHash" TEXT NOT NULL,
    "payload" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_otps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "auth_otps_email_purpose_idx" ON "auth_otps"("email", "purpose");

-- CreateIndex
CREATE INDEX "auth_otps_userId_purpose_idx" ON "auth_otps"("userId", "purpose");
