import { Request, Response } from 'express';
import * as svc from './category.service';
import { ok, created, noContent, notFound } from '../../lib/response';
import { importCategoriesFromExcel, buildCategoryTemplate } from './category.import';
import { AuthRequest } from '../../middleware/auth.middleware';

export async function list(req: Request, res: Response): Promise<void> {
  const activeOnly = req.query.all !== 'true';
  // `?home=true` → only active categories flagged to show on the home strip.
  const homeOnly = req.query.home === 'true';
  const data = await svc.getCategories(activeOnly, homeOnly);
  ok(res, data);
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const data = await svc.getCategoryById(req.params.id);
  if (!data) { notFound(res); return; }
  ok(res, data);
}

export async function create(req: Request, res: Response): Promise<void> {
  const data = await svc.createCategory(req.body);
  created(res, data);
}

export async function update(req: Request, res: Response): Promise<void> {
  const data = await svc.updateCategory(req.params.id, req.body);
  ok(res, data);
}

export async function remove(req: Request, res: Response): Promise<void> {
  await svc.deleteCategory(req.params.id);
  noContent(res);
}

export async function createSub(req: Request, res: Response): Promise<void> {
  const data = await svc.createSubcategory({ ...req.body, categoryId: req.params.id });
  created(res, data);
}

export async function updateSub(req: Request, res: Response): Promise<void> {
  const data = await svc.updateSubcategory(req.params.subId, req.body);
  ok(res, data);
}

export async function removeSub(req: Request, res: Response): Promise<void> {
  await svc.deleteSubcategory(req.params.subId);
  noContent(res);
}

export async function importExcel(req: AuthRequest, res: Response): Promise<void> {
  const file = (req as { file?: { buffer: Buffer } }).file;
  if (!file) {
    res.status(400).json({ success: false, message: 'No file uploaded (field name: file)' });
    return;
  }
  try {
    const summary = await importCategoriesFromExcel(file.buffer, req.user!.userId);
    ok(
      res,
      summary,
      `Imported ${summary.categoriesCreated + summary.categoriesUpdated} category(ies) and ${summary.subcategoriesCreated + summary.subcategoriesUpdated} subcategory(ies).`,
    );
  } catch (err) {
    res.status(400).json({ success: false, message: (err as Error).message });
  }
}

export async function downloadTemplate(_req: Request, res: Response): Promise<void> {
  const buffer = await buildCategoryTemplate();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="category-import-template.xlsx"');
  res.send(buffer);
}
