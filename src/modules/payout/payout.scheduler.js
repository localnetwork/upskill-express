import { env } from "../../shared/config/env.js";
import { runAutoPayoutProcessing } from "./payout.service.js";

let payoutSchedulerTimer = null;
let payoutSchedulerRunning = false;

async function executeAutoPayout(triggeredBy) {
  if (payoutSchedulerRunning) {
    return null;
  }

  payoutSchedulerRunning = true;
  try {
    const summary = await runAutoPayoutProcessing(triggeredBy);
    if (summary.createdRequests > 0 || summary.failedEducators > 0) {
      console.log("[payout-auto-job]", summary);
    }
    return summary;
  } catch (error) {
    const isDbUnavailable =
      String(error?.name || "") === "PrismaClientInitializationError" ||
      String(error?.message || "").includes("Can't reach database server");

    if (isDbUnavailable) {
      console.warn(
        "[payout-auto-job] skipped: database is unavailable. Set AUTO_PAYOUT_ENABLED=false to disable auto payouts locally.",
      );
    } else {
      console.error("[payout-auto-job] failed", error);
    }
    return null;
  } finally {
    payoutSchedulerRunning = false;
  }
}

export async function runAutoPayoutNow(triggeredBy = "manual") {
  return runAutoPayoutProcessing(triggeredBy);
}

export function startAutoPayoutScheduler() {
  if (!env.autoPayoutEnabled) {
    return;
  }
  if (payoutSchedulerTimer) {
    return;
  }

  executeAutoPayout("startup");
  payoutSchedulerTimer = setInterval(() => {
    executeAutoPayout("scheduler");
  }, env.autoPayoutIntervalMs);
}

export function stopAutoPayoutScheduler() {
  if (payoutSchedulerTimer) {
    clearInterval(payoutSchedulerTimer);
    payoutSchedulerTimer = null;
    console.log("[payout-scheduler] Stopped.");
  }
}
