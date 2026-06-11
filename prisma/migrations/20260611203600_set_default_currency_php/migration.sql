ALTER TABLE "orders"
ALTER COLUMN "currency" SET DEFAULT 'PHP';

ALTER TABLE "payout_requests"
ALTER COLUMN "currency" SET DEFAULT 'PHP';

ALTER TABLE "tax_transactions"
ALTER COLUMN "currency" SET DEFAULT 'PHP';
