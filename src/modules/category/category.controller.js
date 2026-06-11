import {
  createCategory,
  deleteCategory,
  getCategoryBySlugOrId,
  listCategories,
  updateCategory,
} from "./category.service.js";

function toLegacyCategory(category) {
  return {
    ...category,
    title: category.name || category.title,
    category_description: category.description || category.category_description || null,
    parent_id: category.parentId || category.parent_id || null,
    children: (category.children || []).map(toLegacyCategory),
  };
}

export async function createCategoryController(req, res) {
  const data = await createCategory(req.body);
  return res.status(201).json({ message: "Category created", data: toLegacyCategory(data) });
}

export async function updateCategoryController(req, res) {
  const data = await updateCategory(req.params.categoryId, req.body);
  return res.json({ message: "Category updated", data: toLegacyCategory(data) });
}

export async function listCategoriesController(req, res) {
  const data = await listCategories(req.query);
  return res.json({
    message: "Categories fetched",
    ...data,
    data: data.data.map(toLegacyCategory),
  });
}

export async function getCategoryController(req, res) {
  const data = await getCategoryBySlugOrId(req.params.slugOrId);
  return res.json(toLegacyCategory(data));
}

export async function deleteCategoryController(req, res) {
  const data = await deleteCategory(req.params.categoryId);
  return res.json({ message: "Category deleted", data });
}
