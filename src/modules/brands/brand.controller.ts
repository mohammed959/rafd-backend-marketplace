import { Response } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import * as svc from './brand.service';
import { createBrandSchema, updateBrandSchema } from './brand.schema';
import { ok, created, notFound, badRequest } from '../../lib/response';

function qs(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export async function list(req: AuthRequest, res: Response): Promise<void> {
  const data = await svc.listBrands({
    search: qs(req.query.q),
    includeInactive: req.query.all === 'true',
  });
  ok(res, data);
}

export async function getOne(req: AuthRequest, res: Response): Promise<void> {
  const data = await svc.getBrandById(req.params.id);
  if (!data) { notFound(res, 'Brand not found'); return; }
  ok(res, data);
}

export async function create(req: AuthRequest, res: Response): Promise<void> {
  const body = createBrandSchema.parse(req.body);
  try {
    const data = await svc.createBrand(body, req.user!.userId);
    created(res, data, 'Brand created');
  } catch (err) {
    badRequest(res, (err as Error).message);
  }
}

export async function update(req: AuthRequest, res: Response): Promise<void> {
  const body = updateBrandSchema.parse(req.body);
  try {
    const data = await svc.updateBrand(req.params.id, body, req.user!.userId);
    ok(res, data, 'Brand updated');
  } catch (err) {
    badRequest(res, (err as Error).message);
  }
}

export async function remove(req: AuthRequest, res: Response): Promise<void> {
  try {
    const result = await svc.deleteBrand(req.params.id, req.user!.userId);
    ok(
      res,
      result,
      result.disabledInsteadOfDeleted
        ? `Brand disabled (${result.linkedProductCount} product${result.linkedProductCount === 1 ? '' : 's'} still reference it).`
        : 'Brand deleted',
    );
  } catch (err) {
    badRequest(res, (err as Error).message);
  }
}
