import {
  createDiscussionReply,
  createDiscussionThread,
  getDiscussionThread,
  listLessonDiscussions,
  toggleDiscussionVote,
  toggleDiscussionResolved,
} from "./discussion.service.js";

export async function listLessonDiscussionsController(req, res) {
  const data = await listLessonDiscussions(req.user, req.params.slug, req.query);
  return res.json({ message: "Discussions fetched", ...data });
}

export async function createDiscussionThreadController(req, res) {
  const data = await createDiscussionThread(req.user, req.params.slug, req.body);
  return res.status(201).json({ message: "Discussion thread created", data });
}

export async function getDiscussionThreadController(req, res) {
  const data = await getDiscussionThread(req.user, req.params.threadId);
  return res.json({ message: "Discussion fetched", data });
}

export async function createDiscussionReplyController(req, res) {
  const data = await createDiscussionReply(req.user, req.params.threadId, req.body);
  return res.status(201).json({ message: "Discussion reply created", data });
}

export async function toggleDiscussionResolvedController(req, res) {
  const data = await toggleDiscussionResolved(
    req.user,
    req.params.threadId,
    req.body,
  );
  return res.json({ message: "Discussion updated", data });
}

export async function toggleDiscussionVoteController(req, res) {
  const data = await toggleDiscussionVote(req.user, req.params.threadId, req.body);
  return res.json({ message: "Discussion vote updated", data });
}
