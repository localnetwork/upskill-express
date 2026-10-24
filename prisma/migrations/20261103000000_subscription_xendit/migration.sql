-- AlterTable
ALTER TABLE "subscriptions" ADD COLUMN "provider" TEXT NOT NULL DEFAULT 'PAYPAL',
ADD COLUMN "xenditCustomerId" TEXT,
ADD COLUMN "xenditSessionId" TEXT,
ADD COLUMN "xenditPlanId" TEXT,
ADD COLUMN "xenditTokenId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_xenditSessionId_key" ON "subscriptions"("xenditSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_xenditPlanId_key" ON "subscriptions"("xenditPlanId");

-- CreateIndex
CREATE INDEX "subscriptions_xenditCustomerId_idx" ON "subscriptions"("xenditCustomerId");
