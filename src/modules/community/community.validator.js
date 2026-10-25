import { z } from "zod";

const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Invalid color");
const url = z.string().max(1000);

export const slugParams = z.object({ slug: z.string().min(1) });
export const slugMemberParams = z.object({ slug: z.string().min(1), userId: z.string().min(1) });
export const slugReportParams = z.object({ slug: z.string().min(1), reportId: z.string().min(1) });
export const postParams = z.object({ postId: z.string().min(1) });
export const commentParams = z.object({ commentId: z.string().min(1) });

export const createCommunityBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(1000).optional(),
});

export const updateCommunityBody = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().trim().max(1000).optional(),
  photoUrl: url.optional(),
  coverUrl: url.optional(),
  themeColor: color.optional(),
});

export const COMMUNITY_BADGES = [
  "New Member",
  "Founding Member",
  "Rising Star",
  "Conversation Starter",
  "Visual Storyteller",
  "Valued Responder",
  "Group Ambassador",
  "Group Expert",
];

export const updateMemberBody = z.object({
  role: z.enum(["MEMBER", "MODERATOR"]).optional(),
  badge: z.enum(COMMUNITY_BADGES).nullable().optional(),
});

export const banBody = z.object({
  reason: z.string().trim().max(300).optional(),
  days: z.union([z.literal(3), z.literal(7), z.literal(30)]).nullable().optional(),
});

export const postBody = z.object({
  body: z.string().trim().min(1).max(5000),
  imageUrl: url.nullable().optional(),
  imageUrls: z.array(url).max(10).optional(),
});

export const commentBody = z.object({
  body: z.string().trim().min(1).max(2000),
  parentId: z.string().min(1).nullable().optional(),
  mediaIndex: z.number().int().min(0).max(9).nullable().optional(),
});
export const pinBody = z.object({ pinned: z.boolean() });

export const reportBody = z.object({
  targetType: z.enum(["POST", "COMMENT"]),
  targetId: z.string().min(1),
  reason: z.string().trim().min(1).max(500),
});

export const resolveBody = z.object({ action: z.enum(["DISMISS", "REMOVE"]) });
