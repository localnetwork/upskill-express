import { Router } from "express";
import { authenticate } from "../../shared/middleware/auth.middleware.js";
import { validate } from "../../shared/middleware/validate.middleware.js";
import { asyncHandler } from "../../shared/utils/asyncHandler.js";
import { upload } from "../../shared/middleware/upload.middleware.js";
import * as svc from "./community.service.js";
import * as v from "./community.validator.js";

const router = Router();
router.use(authenticate);

const ok = (message, status = 200) => (fn) =>
  asyncHandler(async (req, res) => {
    const data = await fn(req);
    return res.status(status).json({ message, data });
  });

router.post(
  "/upload",
  upload.single("file"),
  ok("Uploaded", 201)(async (req) => svc.uploadCommunityImage(req.file)),
);

router.get("/course/:slug", validate(v.slugParams, "params"), ok("Community fetched")((req) => svc.getCommunity(req.params.slug, req.user.id)));
router.post("/course/:slug", validate(v.slugParams, "params"), validate(v.createCommunityBody), ok("Community created", 201)((req) => svc.createCommunity(req.params.slug, req.user.id, req.body)));
router.patch("/course/:slug", validate(v.slugParams, "params"), validate(v.updateCommunityBody), ok("Community updated")((req) => svc.updateCommunity(req.params.slug, req.user.id, req.body)));
router.post("/course/:slug/join", validate(v.slugParams, "params"), ok("Joined")((req) => svc.joinCommunity(req.params.slug, req.user.id)));
router.delete("/course/:slug/join", validate(v.slugParams, "params"), ok("Left")((req) => svc.leaveCommunity(req.params.slug, req.user.id)));

router.get("/course/:slug/members", validate(v.slugParams, "params"), ok("Members fetched")((req) => svc.listMembers(req.params.slug, req.user.id, req.query)));
router.patch("/course/:slug/members/:userId", validate(v.slugMemberParams, "params"), validate(v.updateMemberBody), ok("Member updated")((req) => svc.updateMember(req.params.slug, req.user.id, req.params.userId, req.body)));
router.post("/course/:slug/members/:userId/ban", validate(v.slugMemberParams, "params"), validate(v.banBody), ok("Member banned")((req) => svc.banMember(req.params.slug, req.user.id, req.params.userId, req.body.reason, req.body.days)));
router.delete("/course/:slug/members/:userId/ban", validate(v.slugMemberParams, "params"), ok("Member unbanned")((req) => svc.unbanMember(req.params.slug, req.user.id, req.params.userId)));

router.get("/course/:slug/posts", validate(v.slugParams, "params"), ok("Posts fetched")((req) => svc.listPosts(req.params.slug, req.user.id, req.query)));
router.post("/course/:slug/posts", validate(v.slugParams, "params"), validate(v.postBody), ok("Post created", 201)((req) => svc.createPost(req.params.slug, req.user.id, req.body)));
router.get("/posts/:postId", validate(v.postParams, "params"), ok("Post fetched")((req) => svc.getPost(req.params.postId, req.user.id)));
router.patch("/posts/:postId", validate(v.postParams, "params"), validate(v.postBody), ok("Post updated")((req) => svc.updatePost(req.params.postId, req.user.id, req.body)));
router.delete("/posts/:postId", validate(v.postParams, "params"), ok("Post deleted")((req) => svc.deletePost(req.params.postId, req.user.id)));
router.post("/posts/:postId/pin", validate(v.postParams, "params"), validate(v.pinBody), ok("Post pin updated")((req) => svc.pinPost(req.params.postId, req.user.id, req.body.pinned)));
router.post("/posts/:postId/like", validate(v.postParams, "params"), ok("Like toggled")((req) => svc.toggleLike(req.params.postId, req.user.id)));

router.get("/posts/:postId/comments", validate(v.postParams, "params"), ok("Comments fetched")((req) => svc.listComments(req.params.postId, req.user.id, req.query)));
router.post("/posts/:postId/comments", validate(v.postParams, "params"), validate(v.commentBody), ok("Comment created", 201)((req) => svc.createComment(req.params.postId, req.user.id, req.body)));
router.delete("/comments/:commentId", validate(v.commentParams, "params"), ok("Comment deleted")((req) => svc.deleteComment(req.params.commentId, req.user.id)));

router.post("/course/:slug/reports", validate(v.slugParams, "params"), validate(v.reportBody), ok("Report submitted", 201)((req) => svc.createReport(req.params.slug, req.user.id, req.body)));
router.get("/course/:slug/reports", validate(v.slugParams, "params"), ok("Reports fetched")((req) => svc.listReports(req.params.slug, req.user.id, req.query)));
router.post("/course/:slug/reports/:reportId/resolve", validate(v.slugReportParams, "params"), validate(v.resolveBody), ok("Report resolved")((req) => svc.resolveReport(req.params.slug, req.user.id, req.params.reportId, req.body.action)));

export default router;
