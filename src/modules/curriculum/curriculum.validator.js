import { z } from "zod";

export const createSectionValidator = z.object({
  title: z.string().min(2),
  description: z.string().optional(),
  section_description: z.string().optional(),
  position: z.number().int().min(1).optional(),
  sort_order: z.number().int().min(0).optional(),
});

export const createLessonValidator = z.object({
  type: z.enum(["VIDEO", "QUIZ", "CODING_EXERCISE", "RESOURCE", "ASSIGNMENT"]).optional(),
  curriculum_type: z.string().optional(),
  title: z.string().min(2),
  description: z.string().optional(),
  curriculum_description: z.string().optional(),
  position: z.number().int().min(1).optional(),
  sort_order: z.number().int().min(0).optional(),
  durationInSeconds: z.number().int().min(0).optional(),
  estimated_duration: z.number().int().min(0).optional(),
  isPreview: z.boolean().optional(),
  published: z.boolean().optional(),
  videoUrl: z.string().optional(),
  resourceUrl: z.string().optional(),
  assignmentText: z.string().optional(),
  codingInstructions: z.string().optional(),
  codingStarterCode: z.string().optional(),
  quizQuestions: z.any().optional(),
});
