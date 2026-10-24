-- CreateEnum
CREATE TYPE "EnrollmentAccessSource" AS ENUM ('PURCHASE', 'TRIAL', 'SUBSCRIPTION');

-- CreateEnum
CREATE TYPE "EntitlementSource" AS ENUM ('TRIAL', 'SUBSCRIPTION', 'ADMIN');

-- CreateEnum
CREATE TYPE "PlanInterval" AS ENUM ('MONTH', 'YEAR');

-- CreateEnum
CREATE TYPE "SubscriptionStatus" AS ENUM ('PENDING', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "SubscriptionInvoiceStatus" AS ENUM ('PAID', 'REFUNDED', 'FAILED');

-- CreateEnum
CREATE TYPE "TrialEventType" AS ENUM ('STARTED', 'COURSE_ACCESSED', 'CONVERTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "EarningsCycleStatus" AS ENUM ('OPEN', 'CALCULATED', 'PUBLISHED');

-- CreateEnum
CREATE TYPE "EducatorEarningType" AS ENUM ('SUBSCRIPTION_POOL', 'TRIAL_CONVERSION');

-- CreateEnum
CREATE TYPE "EducatorEarningStatus" AS ENUM ('PENDING', 'AVAILABLE', 'PAID');

-- AlterEnum
ALTER TYPE "EnrollmentStatus" ADD VALUE 'EXPIRED';

-- AlterTable
ALTER TABLE "courses" ADD COLUMN     "subscriptionEligible" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "trialEligible" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "trialOptInAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "enrollments" ADD COLUMN     "accessEndsAt" TIMESTAMP(3),
ADD COLUMN     "accessSource" "EnrollmentAccessSource" NOT NULL DEFAULT 'PURCHASE',
ALTER COLUMN "orderId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "trialEndsAt" TIMESTAMP(3),
ADD COLUMN     "trialStartedAt" TIMESTAMP(3);



-- CreateTable
CREATE TABLE "entitlements" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "source" "EntitlementSource" NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entitlements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trial_events" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "courseId" TEXT,
    "type" "TrialEventType" NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trial_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trial_signup_fingerprints" (
    "id" TEXT NOT NULL,
    "ipHash" TEXT NOT NULL,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "trial_signup_fingerprints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "plans" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "interval" "PlanInterval" NOT NULL,
    "price" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'PHP',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "paypalPlanId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "plans_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "planId" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'PENDING',
    "paypalSubscriptionId" TEXT,
    "currentPeriodStart" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "cancelAtPeriodEnd" BOOLEAN NOT NULL DEFAULT false,
    "canceledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_invoices" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "taxAmount" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "netAmount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'PHP',
    "status" "SubscriptionInvoiceStatus" NOT NULL DEFAULT 'PAID',
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "watch_sessions" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "educatorId" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "day" DATE NOT NULL,
    "seconds" INTEGER NOT NULL DEFAULT 0,
    "source" "EnrollmentAccessSource" NOT NULL,
    "lastBeatAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "watch_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "earnings_cycles" (
    "id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "status" "EarningsCycleStatus" NOT NULL DEFAULT 'OPEN',
    "netRevenue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "poolPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "poolAmount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "totalSeconds" INTEGER NOT NULL DEFAULT 0,
    "calculatedAt" TIMESTAMP(3),
    "publishedAt" TIMESTAMP(3),
    "publishedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "earnings_cycles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "educator_earnings" (
    "id" TEXT NOT NULL,
    "educatorId" TEXT NOT NULL,
    "cycleId" TEXT,
    "courseId" TEXT,
    "type" "EducatorEarningType" NOT NULL,
    "status" "EducatorEarningStatus" NOT NULL DEFAULT 'PENDING',
    "amount" DECIMAL(12,2) NOT NULL,
    "seconds" INTEGER NOT NULL DEFAULT 0,
    "dedupeKey" TEXT NOT NULL,
    "payoutRequestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "educator_earnings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "entitlements_userId_endsAt_idx" ON "entitlements"("userId", "endsAt");

-- CreateIndex
CREATE INDEX "trial_events_userId_type_idx" ON "trial_events"("userId", "type");

-- CreateIndex
CREATE INDEX "trial_events_courseId_type_idx" ON "trial_events"("courseId", "type");

-- CreateIndex
CREATE INDEX "trial_signup_fingerprints_ipHash_createdAt_idx" ON "trial_signup_fingerprints"("ipHash", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_paypalSubscriptionId_key" ON "subscriptions"("paypalSubscriptionId");

-- CreateIndex
CREATE INDEX "subscriptions_userId_status_idx" ON "subscriptions"("userId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_invoices_externalId_key" ON "subscription_invoices"("externalId");

-- CreateIndex
CREATE INDEX "subscription_invoices_paidAt_idx" ON "subscription_invoices"("paidAt");

-- CreateIndex
CREATE INDEX "watch_sessions_day_source_idx" ON "watch_sessions"("day", "source");

-- CreateIndex
CREATE INDEX "watch_sessions_educatorId_day_idx" ON "watch_sessions"("educatorId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "watch_sessions_userId_lessonId_day_key" ON "watch_sessions"("userId", "lessonId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "earnings_cycles_month_key" ON "earnings_cycles"("month");

-- CreateIndex
CREATE UNIQUE INDEX "educator_earnings_dedupeKey_key" ON "educator_earnings"("dedupeKey");

-- CreateIndex
CREATE INDEX "educator_earnings_educatorId_status_idx" ON "educator_earnings"("educatorId", "status");

-- CreateIndex
CREATE INDEX "educator_earnings_cycleId_idx" ON "educator_earnings"("cycleId");

-- AddForeignKey
ALTER TABLE "entitlements" ADD CONSTRAINT "entitlements_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trial_events" ADD CONSTRAINT "trial_events_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trial_events" ADD CONSTRAINT "trial_events_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_planId_fkey" FOREIGN KEY ("planId") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_invoices" ADD CONSTRAINT "subscription_invoices_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watch_sessions" ADD CONSTRAINT "watch_sessions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watch_sessions" ADD CONSTRAINT "watch_sessions_educatorId_fkey" FOREIGN KEY ("educatorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "watch_sessions" ADD CONSTRAINT "watch_sessions_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "educator_earnings" ADD CONSTRAINT "educator_earnings_educatorId_fkey" FOREIGN KEY ("educatorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "educator_earnings" ADD CONSTRAINT "educator_earnings_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "earnings_cycles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "educator_earnings" ADD CONSTRAINT "educator_earnings_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "educator_earnings" ADD CONSTRAINT "educator_earnings_payoutRequestId_fkey" FOREIGN KEY ("payoutRequestId") REFERENCES "payout_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

