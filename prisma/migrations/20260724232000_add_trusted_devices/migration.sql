CREATE TABLE "trusted_devices" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "deviceIdentifier" TEXT,
  "tokenDigest" TEXT NOT NULL,
  "deviceName" TEXT NOT NULL,
  "userAgent" TEXT,
  "ipAddress" TEXT,
  "locationLabel" TEXT,
  "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "trusted_devices_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "trusted_devices_tokenDigest_key" ON "trusted_devices"("tokenDigest");
CREATE INDEX "trusted_devices_userId_revokedAt_lastUsedAt_idx" ON "trusted_devices"("userId", "revokedAt", "lastUsedAt");
CREATE INDEX "trusted_devices_userId_deviceIdentifier_revokedAt_idx" ON "trusted_devices"("userId", "deviceIdentifier", "revokedAt");

ALTER TABLE "trusted_devices"
ADD CONSTRAINT "trusted_devices_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
