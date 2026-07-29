-- Add course-scoped coupon ownership fields
ALTER TABLE "coupons"
ADD COLUMN "courseId" TEXT,
ADD COLUMN "createdById" TEXT;

ALTER TABLE "coupons"
ADD CONSTRAINT "coupons_courseId_fkey"
FOREIGN KEY ("courseId")
REFERENCES "courses"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;

ALTER TABLE "coupons"
ADD CONSTRAINT "coupons_createdById_fkey"
FOREIGN KEY ("createdById")
REFERENCES "users"("id")
ON DELETE SET NULL
ON UPDATE CASCADE;

CREATE INDEX "coupons_courseId_idx" ON "coupons"("courseId");
CREATE INDEX "coupons_createdById_idx" ON "coupons"("createdById");
