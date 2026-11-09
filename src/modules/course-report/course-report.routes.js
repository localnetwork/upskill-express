import { Router } from "express";
import { authenticate } from "../../shared/middleware/auth.middleware.js";
import { validate } from "../../shared/middleware/validate.middleware.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { COURSE_REPORT_ISSUE_TYPES } from "../../shared/constants/courseReports.js";
import { createCourseReport } from "./course-report.service.js";
import { createCourseReportValidator } from "./course-report.validator.js";

const router = Router();

router.use(authenticate);
router.get("/issue-types", (_req, res) =>
  res.json({
    message: "Issue types fetched",
    data: Object.entries(COURSE_REPORT_ISSUE_TYPES).map(([value, label]) => ({ value, label })),
  }),
);
router.post(
  "/",
  validate(createCourseReportValidator),
  asyncHandler(async (req, res) => {
    const data = await createCourseReport(req.user.id, req.body.courseId, req.body);
    return res.status(201).json({ message: "Report submitted. Thank you for letting us know.", data });
  }),
);

export default router;
