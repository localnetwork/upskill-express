import { createCategory, deleteCategory, listCategories, updateCategory } from "./category.service.js";

export async function createCategoryController(req, res) {
  const data = await createCategory(req.body);
  return res.status(201).json({ message: "Category created", data });
}

export async function updateCategoryController(req, res) {
  const data = await updateCategory(req.params.categoryId, req.body);
  return res.json({ message: "Category updated", data });
}

export async function listCategoriesController(req, res) {
  const data = await listCategories(req.query);
  return res.json({ message: "Categories fetched", ...data });
}

export async function deleteCategoryController(req, res) {
  const data = await deleteCategory(req.params.categoryId);
  return res.json({ message: "Category deleted", data });
}
