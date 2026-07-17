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
    console.error("[payout-auto-job] failed", error);
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
