import { Router } from "express";
import { authenticate } from "../../shared/middleware/auth.middleware.js";
import { validate } from "../../shared/middleware/validate.middleware.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import {
  answerMockInterviewController,
  finishMockInterviewController,
  getMockInterviewController,
  listMockInterviewsController,
  startMockInterviewController,
} from "./mock-interview.controller.js";
import {
  answerMockInterviewValidator,
  startMockInterviewValidator,
} from "./mock-interview.validator.js";

const router = Router();
router.use(authenticate);
router.get("/", asyncHandler(listMockInterviewsController));
router.post("/", validate(startMockInterviewValidator), asyncHandler(startMockInterviewController));
router.get("/:id", asyncHandler(getMockInterviewController));
router.post("/:id/answer", validate(answerMockInterviewValidator), asyncHandler(answerMockInterviewController));
router.post("/:id/finish", asyncHandler(finishMockInterviewController));

export default router;
