-- CreateTable
CREATE TABLE "course_reports" (
    "id" TEXT NOT NULL,
    "courseId" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "issueType" TEXT NOT NULL,
    "details" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "course_reports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "course_reports_status_createdAt_idx" ON "course_reports"("status", "createdAt");

-- CreateIndex
CREATE INDEX "course_reports_courseId_status_idx" ON "course_reports"("courseId", "status");

-- CreateIndex
CREATE INDEX "course_reports_reporterId_courseId_idx" ON "course_reports"("reporterId", "courseId");

-- AddForeignKey
ALTER TABLE "course_reports" ADD CONSTRAINT "course_reports_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "courses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "course_reports" ADD CONSTRAINT "course_reports_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
