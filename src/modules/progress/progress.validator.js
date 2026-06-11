import { z } from "zod";

export const updateLessonProgressValidator = z.object({
  lessonId: z.string(),
  progressPct: z.number().min(0).max(100),
  lastPosition: z.number().int().min(0).optional(),
  isCompleted: z.boolean().optional(),
});
