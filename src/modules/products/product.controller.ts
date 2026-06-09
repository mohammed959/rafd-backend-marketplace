import { Request, Response } from 'express';
import * as svc from './product.service';
import {
  adjustStockSchema,
  createProductSchema,
  updateProductSchema,
} from './product.schema';
import { ok, created, noContent, notFound, badRequest } from '../../lib/response';

function qs(val: unknown): string | undefined {
  return typeof val === 'string' ? val : undefined;
}

export async function list(req: Request, res: Response): Promise<void> {
  const rawLimit = parseInt(qs(req.query.pageSize) ?? qs(req.query.limit) ?? '20') || 20;
  const limit = Math.max(1, Math.min(100, rawLimit));
  const result = await svc.listProducts({
    categoryId: qs(req.query.categoryId),
    subcategoryId: qs(req.query.subcategoryId),
    brandId: qs(req.query.brandId),
    featured: req.query.featured === 'true' ? true : undefined,
    search: qs(req.query.q),
    page: parseInt(qs(req.query.page) ?? '1') || 1,
    limit,
    includeOutOfStock: req.query.includeOutOfStock === 'true',
    includeInactive: req.query.all === 'true',
    excludeHiddenFromHome: req.query.excludeHiddenFromHome === 'true',
  });
  ok(res, result);
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const data = await svc.getProductById(req.params.id);
  if (!data) { notFound(res); return; }
  ok(res, data);
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = createProductSchema.parse(req.body);
  try {
    const data = await svc.createProduct(body);
    created(res, data, 'Product created');
  } catch (err) {
    badRequest(res, (err as Error).message);
  }
}

export async function update(req: Request, res: Response): Promise<void> {
  const body = updateProductSchema.parse(req.body);
  try {
    const data = await svc.updateProduct(req.params.id, body);
    ok(res, data, 'Product updated');
  } catch (err) {
    badRequest(res, (err as Error).message);
  }
}

export async function toggleStatus(req: Request, res: Response): Promise<void> {
  const { isActive } = req.body as { isActive: boolean };
  const data = await svc.toggleProductStatus(req.params.id, isActive);
  ok(res, data);
}

export async function remove(req: Request, res: Response): Promise<void> {
  await svc.deleteProduct(req.params.id);
  noContent(res);
}

export async function adjustStock(req: Request, res: Response): Promise<void> {
  const body = adjustStockSchema.parse(req.body);
  try {
    const data = await svc.adjustProductStock(req.params.id, body);
    ok(res, data, 'Stock adjusted');
  } catch (err) {
    badRequest(res, (err as Error).message);
  }
}

export async function featured(_req: Request, res: Response): Promise<void> {
  const data = await svc.getFeaturedProducts();
  ok(res, data);
}

export async function search(req: Request, res: Response): Promise<void> {
  const limit = parseInt(qs(req.query.pageSize) ?? qs(req.query.limit) ?? '20') || 20;
  const data = await svc.searchProducts({
    q: qs(req.query.q),
    barcode: qs(req.query.barcode),
    page: parseInt(qs(req.query.page) ?? '1') || 1,
    limit,
  });
  ok(res, data);
}

export async function suggestions(req: Request, res: Response): Promise<void> {
  const data = await svc.searchSuggestions(qs(req.query.q) ?? '');
  ok(res, data);
}

export async function lowStock(req: Request, res: Response): Promise<void> {
  const threshold = parseInt(qs(req.query.threshold) ?? '5') || 5;
  const data = await svc.listLowStockProducts(threshold);
  ok(res, data);
}

import { importProductsFromExcel, buildSampleTemplate } from './product.import';
import { AuthRequest } from '../../middleware/auth.middleware';

export async function importExcel(req: AuthRequest, res: Response): Promise<void> {
  const file = (req as any).file as { buffer: Buffer; originalname: string } | undefined;
  if (!file) {
    res.status(400).json({ success: false, message: 'No file uploaded (field name: file)' });
    return;
  }
  try {
    const summary = await importProductsFromExcel(file.buffer, req.user!.userId);
    ok(res, summary, `Imported ${summary.productsCreated} product(s)`);
  } catch (err) {
    res.status(400).json({ success: false, message: (err as Error).message });
  }
}

export async function downloadTemplate(_req: Request, res: Response): Promise<void> {
  const buffer = await buildSampleTemplate();
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="product-import-template.xlsx"');
  res.send(buffer);
}
