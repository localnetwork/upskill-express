-- CreateEnum
CREATE TYPE "ActivityEventType" AS ENUM (
  'AUTH_REGISTER',
  'AUTH_LOGIN',
  'ACCOUNT_PROFILE_UPDATED',
  'LEARNING_LESSON_PROGRESS',
  'LEARNING_COURSE_COMPLETED',
  'LEARNING_REVIEW_CREATED',
  'COMMERCE_CART_ADD',
  'COMMERCE_WISHLIST_ADD',
  'COMMERCE_CHECKOUT_CREATED',
  'COMMERCE_PURCHASE_COMPLETED',
  'COURSE_IMPRESSION',
  'COURSE_PAGE_VIEW'
);

-- CreateTable
CREATE TABLE "activity_events" (
  "id" TEXT NOT NULL,
  "eventType" "ActivityEventType" NOT NULL,
  "userId" TEXT,
  "courseId" TEXT,
  "pagePath" TEXT,
  "sessionKey" TEXT,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "activity_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "activity_events_userId_createdAt_idx" ON "activity_events"("userId", "createdAt");
CREATE INDEX "activity_events_courseId_createdAt_idx" ON "activity_events"("courseId", "createdAt");
CREATE INDEX "activity_events_eventType_createdAt_idx" ON "activity_events"("eventType", "createdAt");
CREATE INDEX "activity_events_sessionKey_createdAt_idx" ON "activity_events"("sessionKey", "createdAt");

ALTER TABLE "activity_events"
ADD CONSTRAINT "activity_events_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "activity_events"
ADD CONSTRAINT "activity_events_courseId_fkey"
FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

