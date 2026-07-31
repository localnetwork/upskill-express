import { z } from "zod";

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((value) => {
    if (typeof value === "boolean") return value;
    const normalized = String(value || "").trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes";
  });

const optionalDateString = z
  .string()
  .trim()
  .optional()
  .refine((value) => {
    if (!value) return true;
    return !Number.isNaN(new Date(value).getTime());
  }, "Invalid date value");

export const listInstructorMessagesValidator = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  unread: booleanish.optional(),
  important: booleanish.optional(),
  notAnswered: booleanish.optional(),
  showAutomated: booleanish.optional(),
  sort: z.enum(["recent", "oldest"]).optional(),
});

export const listInstructorQaValidator = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  onlyUnanswered: booleanish.optional(),
  courseId: z.string().trim().optional(),
});

const announcementBaseSchema = z.object({
  courseId: z.string().trim().min(1),
  excludeCourseId: z.string().trim().optional().nullable(),
  useEnrollmentDate: booleanish.optional(),
  useCourseProgress: booleanish.optional(),
  includeAfter: optionalDateString,
  includeBefore: optionalDateString,
  progressZero: booleanish.optional(),
  progressOneToFortyNine: booleanish.optional(),
  progressFiftyToNinetyNine: booleanish.optional(),
  progressCompleted: booleanish.optional(),
});

export const saveAnnouncementDraftValidator = announcementBaseSchema.extend({
  subject: z.string().trim().max(180).optional(),
  body: z.string().trim().max(5000).optional(),
});

export const sendAnnouncementValidator = announcementBaseSchema.extend({
  subject: z.string().trim().min(1).max(180),
  body: z.string().trim().min(1).max(5000),
});

export const upsertNudgeRuleValidator = z.object({
  inactivityDaysThreshold: z.coerce.number().int().min(1).max(180).optional(),
  lowProgressThreshold: z.coerce.number().int().min(1).max(99).optional(),
  enabledInactivityNudge: booleanish.optional(),
  enabledLowProgressNudge: booleanish.optional(),
});

export const runNudgesValidator = z.object({
  courseId: z.string().trim().min(1),
});

export const learnerHealthValidator = z.object({
  courseId: z.string().trim().min(1),
});
