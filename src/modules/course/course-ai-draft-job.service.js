import { randomUUID } from "crypto";
import { ApiError } from "../../shared/utils/ApiError.js";
import { createCourseAIDraft } from "./course.service.js";

const JOB_TTL_MS = 30 * 60 * 1000;
const aiDraftJobs = new Map();

function pruneExpiredJobs() {
  const now = Date.now();
  for (const [jobId, job] of aiDraftJobs.entries()) {
    if (Number(job?.expiresAt || 0) <= now) {
      aiDraftJobs.delete(jobId);
    }
  }
}

function getPublicJob(job) {
  return {
    id: job.id,
    status: job.status,
    progressPercent: job.progressPercent,
    step: job.step,
    message: job.message,
    preview: job.preview,
    draftProgress: job.draftProgress,
    result: job.result,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export function createCourseAIDraftJob(userId, payload) {
  pruneExpiredJobs();

  const id = randomUUID();
  const nowIso = new Date().toISOString();
  const expiresAt = Date.now() + JOB_TTL_MS;
  const job = {
    id,
    userId,
    status: "queued",
    progressPercent: 0,
    step: "queued",
    message: "Queued",
    preview: null,
    draftProgress: null,
    result: null,
    error: null,
    createdAt: nowIso,
    updatedAt: nowIso,
    expiresAt,
  };
  aiDraftJobs.set(id, job);

  setImmediate(async () => {
    try {
      const runningAt = new Date().toISOString();
      const current = aiDraftJobs.get(id);
      if (!current) return;

      current.status = "running";
      current.step = "starting";
      current.message = "Starting AI draft generation";
      current.progressPercent = 5;
      current.updatedAt = runningAt;

      const data = await createCourseAIDraft(userId, payload, {
        onProgress: (progressPayload = {}) => {
          const active = aiDraftJobs.get(id);
          if (!active) return;
          active.status = "running";
          if (progressPayload.step) active.step = String(progressPayload.step);
          if (progressPayload.message) {
            active.message = String(progressPayload.message);
          }
          if (Number.isFinite(progressPayload.progressPercent)) {
            active.progressPercent = Math.max(
              0,
              Math.min(100, Number(progressPayload.progressPercent)),
            );
          }
          if (progressPayload.preview) {
            active.preview = progressPayload.preview;
          }
          if (progressPayload.draftProgress) {
            active.draftProgress = progressPayload.draftProgress;
          }
          active.updatedAt = new Date().toISOString();
        },
      });

      const completed = aiDraftJobs.get(id);
      if (!completed) return;
      completed.status = "completed";
      completed.step = "completed";
      completed.message = "Draft ready";
      completed.progressPercent = 100;
      completed.result = data;
      completed.updatedAt = new Date().toISOString();
      completed.expiresAt = Date.now() + JOB_TTL_MS;
    } catch (error) {
      const failed = aiDraftJobs.get(id);
      if (!failed) return;
      failed.status = "failed";
      failed.step = "failed";
      failed.message = "AI draft generation failed";
      failed.error = error?.message || "Unable to generate AI draft";
      failed.updatedAt = new Date().toISOString();
      failed.expiresAt = Date.now() + JOB_TTL_MS;
    }
  });

  return getPublicJob(job);
}

export function getCourseAIDraftJob(userId, jobId) {
  pruneExpiredJobs();

  const job = aiDraftJobs.get(String(jobId || "").trim());
  if (!job || job.userId !== userId) {
    throw new ApiError(404, "AI draft job not found");
  }

  return getPublicJob(job);
}

export function getLatestActiveCourseAIDraftJob(userId) {
  pruneExpiredJobs();

  const activeStatuses = new Set(["queued", "running"]);
  const userJobs = Array.from(aiDraftJobs.values()).filter(
    (job) => job.userId === userId && activeStatuses.has(job.status),
  );

  if (!userJobs.length) return null;

  const latestJob = userJobs.sort((a, b) => {
    const aTime = new Date(a.updatedAt || a.createdAt || 0).getTime();
    const bTime = new Date(b.updatedAt || b.createdAt || 0).getTime();
    return bTime - aTime;
  })[0];

  return getPublicJob(latestJob);
}
