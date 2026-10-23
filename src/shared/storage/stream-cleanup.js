import { prisma } from "../database/prisma.js";
import {
  deleteBunnyStreamVideo,
  extractBunnyVideoIdFromPlaybackUrl,
} from "./bunny-stream.js";
import {
  deleteCloudflareStreamVideo,
  extractCloudflareVideoIdFromPlaybackUrl,
  isCloudflareStreamEnabled,
} from "./cloudflare-stream.js";

async function deleteByUrl(videoUrl) {
  const bunnyId = extractBunnyVideoIdFromPlaybackUrl(videoUrl);
  if (bunnyId) return deleteBunnyStreamVideo(bunnyId);
  if (isCloudflareStreamEnabled()) {
    const cfId = extractCloudflareVideoIdFromPlaybackUrl(videoUrl);
    if (cfId) return deleteCloudflareStreamVideo(cfId);
  }
  return undefined;
}

async function deleteByUploadRecord(record) {
  if (/bunnycdn\.com/i.test(String(record.uploadUrl || ""))) {
    return deleteBunnyStreamVideo(record.providerVideoId);
  }
  return deleteCloudflareStreamVideo(record.providerVideoId);
}

// Best-effort removal of stream videos (finished and half-uploaded) for lessons.
// Call BEFORE deleting the lessons, since the upload records cascade with them.
export async function deleteStreamVideosForLessons(where) {
  try {
    const lessons = await prisma.lesson.findMany({
      where,
      select: { id: true, videoUrl: true },
    });
    if (!lessons.length) return;
    const uploads = await prisma.lessonVideoUpload.findMany({
      where: { lessonId: { in: lessons.map((l) => l.id) } },
    });
    await Promise.allSettled([
      ...lessons.filter((l) => l.videoUrl).map((l) => deleteByUrl(l.videoUrl)),
      ...uploads.map(deleteByUploadRecord),
    ]);
  } catch (error) {
    console.error("Stream video cleanup failed:", error?.message || error);
  }
}
