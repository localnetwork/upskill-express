ALTER TABLE "trusted_devices"
ADD COLUMN "expiresAt" TIMESTAMP(3);

UPDATE "trusted_devices"
SET "expiresAt" = CURRENT_TIMESTAMP + INTERVAL '45 days'
WHERE "expiresAt" IS NULL;

ALTER TABLE "trusted_devices"
ALTER COLUMN "expiresAt" SET NOT NULL;

CREATE INDEX "trusted_devices_userId_revokedAt_expiresAt_idx"
ON "trusted_devices"("userId", "revokedAt", "expiresAt");
