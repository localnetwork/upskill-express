import { expireLapsedEnrollments } from "./access.service.js";
import { runTrialLifecycleJobs } from "./trial.service.js";
import { expireLapsedSubscriptions } from "../subscription/subscription.service.js";
import { autoCalculatePreviousCycle } from "../earnings/earnings.service.js";

const INTERVAL_MS = 60 * 60 * 1000;
let timer = null;
let running = false;

async function runAccessJobs() {
  if (running) return;
  running = true;
  try {
    const expiredEnrollments = await expireLapsedEnrollments();
    const expiredSubscriptions = await expireLapsedSubscriptions();
    const trial = await runTrialLifecycleJobs();
    const cycle = await autoCalculatePreviousCycle();
    if (expiredEnrollments || expiredSubscriptions || trial.reminded || trial.expired || cycle) {
      console.log("[access-job]", {
        expiredEnrollments,
        expiredSubscriptions,
        trial,
        calculatedCycle: cycle?.month || null,
      });
    }
  } catch (error) {
    console.error("[access-job] failed", error);
  } finally {
    running = false;
  }
}

export function startAccessScheduler() {
  if (timer) return;
  runAccessJobs();
  timer = setInterval(runAccessJobs, INTERVAL_MS);
}

export function stopAccessScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
