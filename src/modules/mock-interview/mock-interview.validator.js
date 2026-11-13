import { z } from "zod";

export const startMockInterviewValidator = z.object({
  courseId: z.string().min(1),
  role: z.string().trim().max(100).optional(),
  difficulty: z.enum(["beginner", "intermediate", "advanced"]).optional(),
  maxQuestions: z.number().int().min(3).max(10).optional(),
});

export const answerMockInterviewValidator = z.object({
  answer: z.string().trim().min(1).max(4000),
});
