import {
  createTag,
  deleteTag,
  getTagBySlugOrId,
  listTags,
  mapLegacyTagResult,
  updateTag,
} from "./tag.service.js";

function toLegacyTag(tag) {
  return {
    ...tag,
    title: tag.name || tag.title,
    category_id: tag.categoryId || tag.category_id || null,
  };
}

export async function createTagController(req, res) {
  const data = await createTag(req.body);
  return res.status(201).json({ message: "Tag created", data: toLegacyTag(data) });
}

export async function updateTagController(req, res) {
  const data = await updateTag(req.params.tagId, req.body);
  return res.json({ message: "Tag updated", data: toLegacyTag(data) });
}

export async function listTagsController(req, res) {
  const data = await listTags(req.query);
  return res.json({
    message: "Tags fetched",
    ...mapLegacyTagResult(data),
  });
}

export async function getTagController(req, res) {
  const data = await getTagBySlugOrId(req.params.slugOrId);
  return res.json(toLegacyTag(data));
}

export async function deleteTagController(req, res) {
  const data = await deleteTag(req.params.tagId);
  return res.json({ message: "Tag deleted", data });
}
