import { env } from "../../shared/config/env.js";
import { prisma } from "../../shared/database/prisma.js";
import { runCourseNudges } from "./communication.service.js";

let schedulerHandle = null;
let schedulerBusy = false;

async function executeNudgeCycle() {
  if (schedulerBusy) return;
  schedulerBusy = true;
  try {
    const rules = await prisma.courseNudgeRule.findMany({
      where: {
        OR: [
          { enabledInactivityNudge: true },
          { enabledLowProgressNudge: true },
        ],
        course: {
          deletedAt: null,
        },
      },
      select: {
        courseId: true,
        educatorId: true,
      },
    });

    for (const rule of rules) {
      try {
        await runCourseNudges(rule.educatorId, rule.courseId);
      } catch (error) {
        console.error(
          `[nudge-scheduler] Failed for course ${rule.courseId}:`,
          error?.message || error,
        );
      }
    }
  } finally {
    schedulerBusy = false;
  }
}

export function startAutoNudgeScheduler() {
  if (!env.autoNudgeEnabled) return;
  if (schedulerHandle) return;

  executeNudgeCycle().catch((error) => {
    console.error("[nudge-scheduler] Initial run failed:", error?.message || error);
  });

  schedulerHandle = setInterval(() => {
    executeNudgeCycle().catch((error) => {
      console.error("[nudge-scheduler] Interval run failed:", error?.message || error);
    });
  }, env.autoNudgeIntervalMs);
  schedulerHandle.unref?.();
}

export function stopAutoNudgeScheduler() {
  if (!schedulerHandle) return;
  clearInterval(schedulerHandle);
  schedulerHandle = null;
}
