import { z } from "zod";
import { COURSE_REPORT_ISSUE_TYPE_KEYS } from "../../shared/constants/courseReports.js";

export const createCourseReportValidator = z.object({
  courseId: z.string().trim().min(1),
  issueType: z.enum(COURSE_REPORT_ISSUE_TYPE_KEYS),
  details: z.string().trim().min(10, "Please describe the issue (at least 10 characters)").max(2000),
});
