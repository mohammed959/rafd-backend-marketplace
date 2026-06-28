import { Request, Response } from 'express';
import { z } from 'zod';
import { AuthRequest } from '../../middleware/auth.middleware';
import * as svc from './settings.service';
import { ok, badRequest } from '../../lib/response';

export async function getHome(_req: Request, res: Response): Promise<void> {
  const data = await svc.getHomeSettings();
  ok(res, data);
}

const updateHomeSchema = z.object({
  allProductsLimit: z
    .number()
    .int()
    .min(svc.ALL_PRODUCTS_LIMIT_MIN)
    .max(svc.ALL_PRODUCTS_LIMIT_MAX)
    .optional(),
});

export async function updateHome(req: AuthRequest, res: Response): Promise<void> {
  try {
    const parsed = updateHomeSchema.parse(req.body);
    const data = await svc.updateHomeSettings(parsed);
    ok(res, data);
  } catch (err) {
    badRequest(res, (err as Error).message);
  }
}
