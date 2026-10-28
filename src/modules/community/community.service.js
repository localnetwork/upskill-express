import { prisma } from "../../shared/database/prisma.js";
import { ApiError } from "../../shared/utils/ApiError.js";
import { activeEnrollmentFilter } from "../access/access.service.js";
import { createNotification } from "../notification/notification.service.js";

const RANK = { MEMBER: 1, MODERATOR: 2, ADMIN: 3 };
const POST_PAGE = 10;
const userSelect = {
  id: true,
  firstName: true,
  lastName: true,
  username: true,
};

async function attachPictures(users) {
  const ids = [...new Set(users.map((u) => u?.id).filter(Boolean))];
  const map = new Map();
  if (!ids.length) return map;

  // The profile picture is the media referenced by the user's picture setting, not just their latest upload.
  const settings = await prisma.platformSetting.findMany({
    where: { key: { in: ids.map((id) => `profile_picture::${id}`) } },
    select: { key: true, value: true },
  });
  const mediaIdByUser = new Map();
  for (const s of settings) {
    let parsed = null;
    try {
      parsed = JSON.parse(s.value);
    } catch {
      parsed = null;
    }
    const mediaId = String(parsed?.mediaId || parsed?.id || s.value || "").trim();
    if (mediaId) mediaIdByUser.set(s.key.slice("profile_picture::".length), mediaId);
  }
  if (!mediaIdByUser.size) return map;

  const rows = await prisma.media.findMany({
    where: { id: { in: [...mediaIdByUser.values()] }, mediaType: "IMAGE" },
    select: { id: true, userId: true, storagePath: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const [userId, mediaId] of mediaIdByUser) {
    const media = byId.get(mediaId);
    if (media && media.userId === userId) map.set(userId, media.storagePath);
  }
  return map;
}

function mapUser(u, pictures) {
  if (!u) return null;
  return {
    id: u.id,
    name: [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || "User",
    username: u.username,
    picture: pictures.get(u.id) || null,
  };
}

async function getContext(slug, userId, { requireCommunity = true } = {}) {
  const course = await prisma.course.findFirst({
    where: { OR: [{ slug }, { id: slug }], deletedAt: null },
    select: { id: true, slug: true, title: true, educatorId: true },
  });
  if (!course) throw new ApiError(404, "Course not found");
  const isAuthor = course.educatorId === userId;
  const community = await prisma.courseCommunity.findUnique({
    where: { courseId: course.id },
  });
  if (requireCommunity && !community) {
    throw new ApiError(404, "This course has no community yet");
  }
  let member = null;
  if (community) {
    member = await prisma.communityMember.findUnique({
      where: { communityId_userId: { communityId: community.id, userId } },
    });
  }
  let enrolled = isAuthor;
  if (!enrolled) {
    const enrollment = await prisma.enrollment.findFirst({
      where: { userId, courseId: course.id, ...activeEnrollmentFilter() },
      select: { id: true },
    });
    enrolled = Boolean(enrollment);
  }
  const role = isAuthor ? "ADMIN" : member?.role || null;
  return { course, community, member, role, isAuthor, enrolled };
}

const DAY_MS = 24 * 60 * 60 * 1000;

const NEW_MEMBER_DAYS = 14;

// "New Member" is automatic for recent joiners unless an admin assigned another badge.
function effectiveBadge(member) {
  if (!member) return null;
  if (member.badge) return member.badge;
  if (member.role === "MEMBER" && member.joinedAt && Date.now() - member.joinedAt.getTime() < NEW_MEMBER_DAYS * DAY_MS) {
    return "New Member";
  }
  return null;
}

// A ban is active until its expiry; a null bannedUntil means permanent.
function isBanActive(member) {
  if (!member?.bannedAt) return false;
  return !member.bannedUntil || member.bannedUntil.getTime() > Date.now();
}

function activeBanWhere() {
  return { bannedAt: { not: null }, OR: [{ bannedUntil: null }, { bannedUntil: { gt: new Date() } }] };
}

function notBannedWhere() {
  return { OR: [{ bannedAt: null }, { bannedUntil: { lte: new Date() } }] };
}

function assertCanView(ctx) {
  if (!ctx.enrolled) throw new ApiError(403, "Enroll in this course to access its community");
  if (isBanActive(ctx.member)) {
    const until = ctx.member.bannedUntil;
    throw new ApiError(
      403,
      until
        ? `You are banned from this community until ${until.toISOString().slice(0, 10)}`
        : "You are banned from this community",
    );
  }
}

function assertJoined(ctx) {
  assertCanView(ctx);
  if (!ctx.role) throw new ApiError(403, "Join the community first");
}

function assertStaff(ctx) {
  assertJoined(ctx);
  if (RANK[ctx.role] < RANK.MODERATOR) throw new ApiError(403, "Moderator access required");
}

function assertAdmin(ctx) {
  assertJoined(ctx);
  if (ctx.role !== "ADMIN") throw new ApiError(403, "Admin access required");
}

async function ensureAdminMember(community, userId) {
  return prisma.communityMember.upsert({
    where: { communityId_userId: { communityId: community.id, userId } },
    update: { role: "ADMIN", bannedAt: null, bannedUntil: null },
    create: { communityId: community.id, userId, role: "ADMIN", badge: null },
  });
}

function mapCommunity(community, course, counts) {
  return {
    id: community.id,
    name: community.name,
    description: community.description,
    photoUrl: community.photoUrl,
    coverUrl: community.coverUrl,
    themeColor: community.themeColor,
    course: { id: course.id, slug: course.slug, title: course.title },
    memberCount: counts?.members ?? 0,
    postCount: counts?.posts ?? 0,
  };
}

export async function getCommunity(slug, userId) {
  const ctx = await getContext(slug, userId, { requireCommunity: false });
  if (!ctx.community) {
    return { community: null, canCreate: ctx.isAuthor, enrolled: ctx.enrolled, role: null };
  }
  if (!ctx.enrolled) {
    const [members, posts] = await Promise.all([
      prisma.communityMember.count({ where: { communityId: ctx.community.id, ...notBannedWhere() } }),
      prisma.communityPost.count({ where: { communityId: ctx.community.id, deletedAt: null } }),
    ]);
    return {
      community: mapCommunity(ctx.community, ctx.course, { members, posts }),
      recentMembers: [],
      recentMedia: [],
      canCreate: false,
      enrolled: false,
      restricted: true,
      role: null,
      me: userId,
      joined: false,
      banned: false,
    };
  }
  if (ctx.isAuthor && !ctx.member) await ensureAdminMember(ctx.community, userId);
  const [members, posts, recent, media] = await Promise.all([
    prisma.communityMember.count({
      where: { communityId: ctx.community.id, ...notBannedWhere() },
    }),
    prisma.communityPost.count({
      where: { communityId: ctx.community.id, deletedAt: null },
    }),
    prisma.communityMember.findMany({
      where: { communityId: ctx.community.id, ...notBannedWhere() },
      orderBy: { joinedAt: "desc" },
      take: 7,
      include: { user: { select: userSelect } },
    }),
    prisma.communityPost.findMany({
      where: { communityId: ctx.community.id, deletedAt: null, imageUrl: { not: null } },
      orderBy: { createdAt: "desc" },
      take: 6,
      select: { id: true, imageUrl: true },
    }),
  ]);
  const pictures = await attachPictures(recent.map((r) => r.user));
  return {
    community: mapCommunity(ctx.community, ctx.course, { members, posts }),
    recentMembers: recent.map((r) => mapUser(r.user, pictures)),
    recentMedia: media,
    canCreate: false,
    enrolled: true,
    role: ctx.role,
    me: userId,
    joined: Boolean(ctx.role),
    banned: isBanActive(ctx.member),
  };
}

export async function createCommunity(slug, userId, body) {
  const ctx = await getContext(slug, userId, { requireCommunity: false });
  if (!ctx.isAuthor) throw new ApiError(403, "Only the course author can create the community");
  if (ctx.community) throw new ApiError(409, "Community already exists");
  const community = await prisma.courseCommunity.create({
    data: {
      courseId: ctx.course.id,
      name: body.name || `${ctx.course.title} Community`,
      description: body.description || null,
    },
  });
  await ensureAdminMember(community, userId);
  return getCommunity(slug, userId);
}

export async function updateCommunity(slug, userId, body) {
  const ctx = await getContext(slug, userId);
  if (!ctx.isAuthor) throw new ApiError(403, "Admin access required");
  const data = {};
  for (const key of ["name", "description", "photoUrl", "coverUrl", "themeColor"]) {
    if (body[key] !== undefined) data[key] = body[key] === "" ? null : body[key];
  }
  if (data.name === null) delete data.name;
  if (data.themeColor === null) data.themeColor = "#2563eb";
  await prisma.courseCommunity.update({ where: { id: ctx.community.id }, data });
  return getCommunity(slug, userId);
}

export async function joinCommunity(slug, userId) {
  const ctx = await getContext(slug, userId);
  assertCanView(ctx);
  if (!ctx.member) {
    await prisma.communityMember.create({
      data: { communityId: ctx.community.id, userId, role: "MEMBER" },
    });
  }
  return getCommunity(slug, userId);
}

export async function leaveCommunity(slug, userId) {
  const ctx = await getContext(slug, userId);
  if (ctx.isAuthor) throw new ApiError(400, "The author cannot leave the community");
  if (ctx.member && !isBanActive(ctx.member)) {
    await prisma.communityMember.delete({ where: { id: ctx.member.id } });
  }
  return { left: true };
}

export async function listMembers(slug, userId, query = {}) {
  const ctx = await getContext(slug, userId);
  assertJoined(ctx);
  const search = String(query.q || "").trim();
  const staff = RANK[ctx.role] >= RANK.MODERATOR;
  const where = {
    communityId: ctx.community.id,
    ...(staff && query.banned === "true" ? activeBanWhere() : notBannedWhere()),
    ...(search
      ? {
          user: {
            OR: [
              { firstName: { contains: search, mode: "insensitive" } },
              { lastName: { contains: search, mode: "insensitive" } },
              { username: { contains: search, mode: "insensitive" } },
            ],
          },
        }
      : {}),
  };
  const rows = await prisma.communityMember.findMany({
    where,
    include: { user: { select: userSelect } },
    orderBy: { joinedAt: "asc" },
    take: 200,
  });
  const pictures = await attachPictures(rows.map((r) => r.user));
  const sorted = rows.sort((a, b) => RANK[b.role] - RANK[a.role]);
  return sorted.map((r) => ({
    ...mapUser(r.user, pictures),
    role: r.role,
    badge: effectiveBadge(r),
    banned: isBanActive(r),
    banReason: staff ? r.banReason : undefined,
    bannedUntil: staff ? r.bannedUntil : undefined,
    joinedAt: r.joinedAt,
  }));
}

async function getTarget(ctx, targetUserId) {
  const target = await prisma.communityMember.findUnique({
    where: {
      communityId_userId: { communityId: ctx.community.id, userId: targetUserId },
    },
  });
  if (!target) throw new ApiError(404, "Member not found");
  return target;
}

export async function updateMember(slug, userId, targetUserId, body) {
  const ctx = await getContext(slug, userId);
  assertAdmin(ctx);
  const target = await getTarget(ctx, targetUserId);
  if (target.role === "ADMIN") throw new ApiError(400, "The admin cannot be modified");
  const data = {};
  if (body.role) data.role = body.role;
  if (body.badge !== undefined) data.badge = body.badge || null;
  await prisma.communityMember.update({ where: { id: target.id }, data });
  return { updated: true };
}

export async function banMember(slug, userId, targetUserId, reason, days) {
  const ctx = await getContext(slug, userId);
  assertStaff(ctx);
  const target = await getTarget(ctx, targetUserId);
  if (RANK[target.role] >= RANK[ctx.role]) {
    throw new ApiError(403, "You cannot ban a member with an equal or higher role");
  }
  await prisma.communityMember.update({
    where: { id: target.id },
    data: {
      bannedAt: new Date(),
      bannedUntil: days ? new Date(Date.now() + days * DAY_MS) : null,
      banReason: reason || null,
    },
  });
  return { banned: true };
}

export async function unbanMember(slug, userId, targetUserId) {
  const ctx = await getContext(slug, userId);
  assertStaff(ctx);
  const target = await getTarget(ctx, targetUserId);
  await prisma.communityMember.update({
    where: { id: target.id },
    data: { bannedAt: null, bannedUntil: null, banReason: null },
  });
  return { banned: false };
}

function postImages(p) {
  if (p.imageUrls?.length) return p.imageUrls;
  return p.imageUrl ? [p.imageUrl] : [];
}

async function mapPosts(posts, userId, ctx) {
  const pictures = await attachPictures(posts.map((p) => p.author));
  const authorIds = posts.map((p) => p.authorId);
  const members = await prisma.communityMember.findMany({
    where: { communityId: ctx.community.id, userId: { in: authorIds } },
    select: { userId: true, role: true, badge: true, joinedAt: true },
  });
  const memberMap = new Map(members.map((m) => [m.userId, m]));
  const liked = posts.length
    ? await prisma.communityReaction.findMany({
        where: { userId, postId: { in: posts.map((p) => p.id) } },
        select: { postId: true },
      })
    : [];
  const likedSet = new Set(liked.map((l) => l.postId));
  return posts.map((p) => {
    const m = memberMap.get(p.authorId);
    return {
      id: p.id,
      body: p.body,
      imageUrl: postImages(p)[0] || null,
      imageUrls: postImages(p),
      pinned: p.pinned,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      author: { ...mapUser(p.author, pictures), role: m?.role || "MEMBER", badge: effectiveBadge(m) },
      likeCount: p._count.reactions,
      commentCount: p._count.comments,
      likedByMe: likedSet.has(p.id),
    };
  });
}

const postInclude = {
  author: { select: userSelect },
  _count: { select: { reactions: true, comments: { where: { deletedAt: null } } } },
};

export async function listPosts(slug, userId, query = {}) {
  const ctx = await getContext(slug, userId);
  assertJoined(ctx);
  const cursor = query.cursor ? String(query.cursor) : null;
  const rows = await prisma.communityPost.findMany({
    where: { communityId: ctx.community.id, deletedAt: null },
    include: postInclude,
    orderBy: [{ pinned: "desc" }, { createdAt: "desc" }, { id: "desc" }],
    take: POST_PAGE + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const hasMore = rows.length > POST_PAGE;
  const page = hasMore ? rows.slice(0, POST_PAGE) : rows;
  return {
    items: await mapPosts(page, userId, ctx),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  };
}

export async function createPost(slug, userId, body) {
  const ctx = await getContext(slug, userId);
  assertJoined(ctx);
  const images = normalizeImages(body);
  const post = await prisma.communityPost.create({
    data: {
      communityId: ctx.community.id,
      authorId: userId,
      body: body.body,
      imageUrl: images[0] || null,
      imageUrls: images,
    },
    include: postInclude,
  });
  const [item] = await mapPosts([post], userId, ctx);
  return item;
}

function normalizeImages(body) {
  if (Array.isArray(body.imageUrls)) return body.imageUrls.filter(Boolean);
  return body.imageUrl ? [body.imageUrl] : [];
}

export async function getPost(postId, userId) {
  const { post, ctx } = await getPostContext(postId, userId);
  const full = await prisma.communityPost.findUnique({ where: { id: post.id }, include: postInclude });
  const [item] = await mapPosts([full], userId, ctx);
  return item;
}

async function getPostContext(postId, userId) {
  const post = await prisma.communityPost.findUnique({
    where: { id: postId },
    include: { community: { include: { course: { select: { slug: true } } } } },
  });
  if (!post || post.deletedAt) throw new ApiError(404, "Post not found");
  const ctx = await getContext(post.community.course.slug, userId);
  assertJoined(ctx);
  return { post, ctx };
}

export async function updatePost(postId, userId, body) {
  const { post, ctx } = await getPostContext(postId, userId);
  if (post.authorId !== userId) throw new ApiError(403, "You can only edit your own post");
  const updated = await prisma.communityPost.update({
    where: { id: postId },
    data: {
      body: body.body,
      ...(body.imageUrl !== undefined || body.imageUrls !== undefined
        ? { imageUrl: normalizeImages(body)[0] || null, imageUrls: normalizeImages(body) }
        : {}),
    },
    include: postInclude,
  });
  const [item] = await mapPosts([updated], userId, ctx);
  return item;
}

export async function deletePost(postId, userId) {
  const { post, ctx } = await getPostContext(postId, userId);
  if (post.authorId !== userId && RANK[ctx.role] < RANK.MODERATOR) {
    throw new ApiError(403, "Not allowed");
  }
  await prisma.communityPost.update({ where: { id: postId }, data: { deletedAt: new Date() } });
  return { deleted: true };
}

export async function pinPost(postId, userId, pinned) {
  const { ctx } = await getPostContext(postId, userId);
  assertStaff(ctx);
  await prisma.communityPost.update({ where: { id: postId }, data: { pinned: Boolean(pinned) } });
  return { pinned: Boolean(pinned) };
}

export async function toggleLike(postId, userId) {
  await getPostContext(postId, userId);
  const where = { postId_userId: { postId, userId } };
  const existing = await prisma.communityReaction.findUnique({ where });
  if (existing) await prisma.communityReaction.delete({ where });
  else await prisma.communityReaction.create({ data: { postId, userId } });
  const likeCount = await prisma.communityReaction.count({ where: { postId } });
  return { liked: !existing, likeCount };
}

export async function listComments(postId, userId, query = {}) {
  await getPostContext(postId, userId);
  const media = query.media !== undefined && query.media !== "" ? Number(query.media) : null;
  const rows = await prisma.communityComment.findMany({
    where: { postId, deletedAt: null, mediaIndex: Number.isInteger(media) ? media : null },
    include: { author: { select: userSelect } },
    orderBy: { createdAt: "asc" },
    take: 200,
  });
  const pictures = await attachPictures(rows.map((r) => r.author));
  return rows.map((c) => ({
    id: c.id,
    parentId: c.parentId,
    mediaIndex: c.mediaIndex,
    body: c.body,
    createdAt: c.createdAt,
    author: mapUser(c.author, pictures),
  }));
}

function displayName(user) {
  return [user?.firstName, user?.lastName].filter(Boolean).join(" ") || user?.username || "Someone";
}

async function notifyComment({ post, ctx, parent, comment, userId }) {
  const actorName = displayName(comment.author);
  const courseTitle = ctx.course.title;
  const base = { courseId: ctx.course.id, courseSlug: ctx.course.slug, postId: post.id, commentId: comment.id };
  const pathFor = (recipientId) => {
    const root =
      recipientId === ctx.course.educatorId
        ? `/instructor/courses/${ctx.course.slug}/community`
        : `/courses/${ctx.course.slug}/community`;
    const media = comment.mediaIndex != null ? `&media=${comment.mediaIndex}` : "";
    return `${root}?post=${post.id}${media}&set=g.${ctx.community.id}`;
  };
  const notified = new Set([userId]);
  const send = async (recipientId, title, message, kind) => {
    if (!recipientId || notified.has(recipientId)) return;
    notified.add(recipientId);
    try {
      await createNotification({
        userId: recipientId,
        type: "SYSTEM",
        title,
        message,
        metadata: { notificationKind: kind, ...base, link: pathFor(recipientId) },
      });
    } catch (error) {
      console.error("Community notification failed", error);
    }
  };

  if (parent) {
    await send(
      parent.authorId,
      "New reply to your comment",
      `${actorName} replied to your comment in ${courseTitle}'s community.`,
      "COMMUNITY_COMMENT_REPLY",
    );
  }
  await send(
    post.authorId,
    "New comment on your post",
    `${actorName} commented on your post in ${courseTitle}'s community.`,
    "COMMUNITY_POST_COMMENT",
  );
}

export async function createComment(postId, userId, body) {
  const { post, ctx } = await getPostContext(postId, userId);
  let parent = null;
  if (body.parentId) {
    parent = await prisma.communityComment.findUnique({ where: { id: body.parentId } });
    if (!parent || parent.deletedAt || parent.postId !== postId) {
      throw new ApiError(404, "Comment to reply to was not found");
    }
  }
  const mediaIndex = parent ? parent.mediaIndex : Number.isInteger(body.mediaIndex) ? body.mediaIndex : null;
  if (!parent && mediaIndex != null && mediaIndex >= Math.max(postImages(post).length, 1)) {
    throw new ApiError(400, "Invalid media");
  }
  const c = await prisma.communityComment.create({
    // Replies stay one level deep: replying to a reply attaches to the top-level comment.
    data: { postId, authorId: userId, body: body.body, mediaIndex, parentId: parent ? parent.parentId || parent.id : null },
    include: { author: { select: userSelect } },
  });
  await notifyComment({ post, ctx, parent, comment: c, userId });
  const pictures = await attachPictures([c.author]);
  return { id: c.id, parentId: c.parentId, mediaIndex: c.mediaIndex, body: c.body, createdAt: c.createdAt, author: mapUser(c.author, pictures) };
}

export async function deleteComment(commentId, userId) {
  const comment = await prisma.communityComment.findUnique({ where: { id: commentId } });
  if (!comment || comment.deletedAt) throw new ApiError(404, "Comment not found");
  const { ctx } = await getPostContext(comment.postId, userId);
  if (comment.authorId !== userId && RANK[ctx.role] < RANK.MODERATOR) {
    throw new ApiError(403, "Not allowed");
  }
  await prisma.communityComment.updateMany({
    where: { OR: [{ id: commentId }, { parentId: commentId }], deletedAt: null },
    data: { deletedAt: new Date() },
  });
  return { deleted: true };
}

export async function createReport(slug, userId, body) {
  const ctx = await getContext(slug, userId);
  assertJoined(ctx);
  const exists =
    body.targetType === "POST"
      ? await prisma.communityPost.findFirst({
          where: { id: body.targetId, communityId: ctx.community.id, deletedAt: null },
        })
      : await prisma.communityComment.findFirst({
          where: { id: body.targetId, deletedAt: null, post: { communityId: ctx.community.id } },
        });
  if (!exists) throw new ApiError(404, "Reported content not found");
  await prisma.communityReport.create({
    data: {
      communityId: ctx.community.id,
      reporterId: userId,
      targetType: body.targetType,
      targetId: body.targetId,
      reason: body.reason,
    },
  });
  return { reported: true };
}

export async function listReports(slug, userId, query = {}) {
  const ctx = await getContext(slug, userId);
  assertStaff(ctx);
  const status = query.status === "RESOLVED" ? { not: "OPEN" } : "OPEN";
  const reports = await prisma.communityReport.findMany({
    where: { communityId: ctx.community.id, status },
    include: { reporter: { select: userSelect } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  const postIds = reports.filter((r) => r.targetType === "POST").map((r) => r.targetId);
  const commentIds = reports.filter((r) => r.targetType === "COMMENT").map((r) => r.targetId);
  const [posts, comments] = await Promise.all([
    postIds.length
      ? prisma.communityPost.findMany({
          where: { id: { in: postIds } },
          include: { author: { select: userSelect } },
        })
      : [],
    commentIds.length
      ? prisma.communityComment.findMany({
          where: { id: { in: commentIds } },
          include: { author: { select: userSelect } },
        })
      : [],
  ]);
  const targets = new Map([...posts, ...comments].map((t) => [t.id, t]));
  const pictures = await attachPictures([
    ...reports.map((r) => r.reporter),
    ...[...targets.values()].map((t) => t.author),
  ]);
  return reports.map((r) => {
    const t = targets.get(r.targetId);
    return {
      id: r.id,
      targetType: r.targetType,
      targetId: r.targetId,
      reason: r.reason,
      status: r.status,
      createdAt: r.createdAt,
      reporter: mapUser(r.reporter, pictures),
      content: t
        ? { body: t.body, deleted: Boolean(t.deletedAt), author: mapUser(t.author, pictures) }
        : null,
    };
  });
}

export async function resolveReport(slug, userId, reportId, action) {
  const ctx = await getContext(slug, userId);
  assertStaff(ctx);
  const report = await prisma.communityReport.findFirst({
    where: { id: reportId, communityId: ctx.community.id },
  });
  if (!report) throw new ApiError(404, "Report not found");
  if (action === "REMOVE") {
    const now = new Date();
    if (report.targetType === "POST") {
      await prisma.communityPost.updateMany({ where: { id: report.targetId }, data: { deletedAt: now } });
    } else {
      await prisma.communityComment.updateMany({ where: { id: report.targetId }, data: { deletedAt: now } });
    }
  }
  await prisma.communityReport.update({
    where: { id: reportId },
    data: {
      status: action === "REMOVE" ? "REMOVED" : "DISMISSED",
      resolvedById: userId,
      resolvedAt: new Date(),
    },
  });
  return { resolved: true };
}

export function uploadCommunityImage(file) {
  if (!file) throw new ApiError(400, "File is required");
  const mimetype = String(file.mimetype || "");
  if (!mimetype.startsWith("image/") && !mimetype.startsWith("video/")) {
    throw new ApiError(400, "Only image or video uploads are allowed");
  }
  const path =
    file.path && /^https?:\/\//i.test(file.path)
      ? file.path
      : file.filename
        ? `/uploads/${file.filename}`
        : file.path;
  return { path };
}
