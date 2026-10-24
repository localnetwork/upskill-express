import { z } from "zod";

export const reviewCourseValidator = z.object({
  note: z.string().optional(),
});

export const createRoleValidator = z.object({
  name: z.string().trim().min(2).max(40),
  description: z.string().trim().max(255).optional(),
  permissionIds: z.array(z.string().min(1)).optional(),
});

export const createUserByAdminValidator = z.object({
  email: z.string().trim().email("Invalid email format"),
  username: z.string().trim().min(3).max(40),
  password: z.string().min(8, "Password must be at least 8 characters").max(128),
  firstName: z.string().trim().max(80).optional(),
  lastName: z.string().trim().max(80).optional(),
  baseRole: z.enum(["LEARNER", "EDUCATOR"]).optional(),
  staffRoles: z.array(z.string().trim().min(2).max(40)).max(10).optional(),
});

export const setUserStaffRolesValidator = z.object({
  roles: z.array(z.string().trim().min(2).max(40)).max(10),
});

export const setRolePermissionsValidator = z.object({
  permissionIds: z.array(z.string().min(1)),
});

export const updatePlatformSettingsValidator = z
  .object({
    platformFeePercent: z.number().min(0).max(100).optional(),
    taxPercent: z.number().min(0).max(100).optional(),
    payoutCycle: z.enum(["ANYTIME", "DAILY", "WEEKLY", "MONTHLY"]).optional(),
    defaultCurrency: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{3}$/)
      .optional(),
    trialEnabled: z.boolean().optional(),
    trialDays: z.number().int().min(1).max(60).optional(),
    trialMaxCoursesPerLearner: z.number().int().min(1).max(50).optional(),
    trialPoolMaxPercent: z.number().min(0).max(100).optional(),
    trialConversionBonus: z.number().min(0).max(100000).optional(),
    trialConversionWindowDays: z.number().int().min(1).max(365).optional(),
    subscriptionPoolPercent: z.number().min(0).max(100).optional(),
  })
  .refine((payload) => Object.values(payload).some((v) => v !== undefined), {
    message: "At least one setting is required",
  });
