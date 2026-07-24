-- CreateTable
CREATE TABLE "payout_request_events" (
  "id" TEXT NOT NULL,
  "payoutRequestId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "payload" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "payout_request_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payout_request_events_payoutRequestId_occurredAt_idx"
ON "payout_request_events"("payoutRequestId", "occurredAt");

-- CreateIndex
CREATE INDEX "payout_request_events_eventType_occurredAt_idx"
ON "payout_request_events"("eventType", "occurredAt");

-- AddForeignKey
ALTER TABLE "payout_request_events"
ADD CONSTRAINT "payout_request_events_payoutRequestId_fkey"
FOREIGN KEY ("payoutRequestId") REFERENCES "payout_requests"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
