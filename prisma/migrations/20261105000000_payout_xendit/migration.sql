-- PayPal payout accounts cannot be reused for Xendit; require instructors to reconnect.
DROP INDEX IF EXISTS "payout_accounts_paypalEmail_idx";

ALTER TABLE "payout_accounts" DROP COLUMN "paypalMerchantId";
ALTER TABLE "payout_accounts" RENAME COLUMN "paypalEmail" TO "accountNumber";
ALTER TABLE "payout_accounts"
  ADD COLUMN "channelCode" TEXT NOT NULL DEFAULT 'PH_GCASH',
  ADD COLUMN "accountHolderName" TEXT NOT NULL DEFAULT '';
ALTER TABLE "payout_accounts"
  ALTER COLUMN "channelCode" DROP DEFAULT,
  ALTER COLUMN "accountHolderName" DROP DEFAULT;
UPDATE "payout_accounts" SET "isVerified" = false;

CREATE INDEX "payout_accounts_channelCode_idx" ON "payout_accounts"("channelCode");

ALTER TABLE "payout_requests" RENAME COLUMN "paypalBatchId" TO "xenditPayoutId";
