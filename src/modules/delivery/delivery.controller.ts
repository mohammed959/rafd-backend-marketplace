import { Response } from 'express';
import { z } from 'zod';
import { AuthRequest } from '../../middleware/auth.middleware';
import * as svc from './delivery.service';
import { ok, badRequest } from '../../lib/response';

/**
 * Phase 3: both `calculateFee` and `quote` delegate to the same
 * `svc.quoteDelivery` after loading subscription context through the
 * shared `svc.loadSubscriptionContext` helper. `fulfillmentType` is
 * optional — when the cart layer doesn't supply it the response is the
 * delivery fee (existing behavior); when PICKUP is supplied the calc
 * returns fee = 0.
 */
export async function calculateFee(req: AuthRequest, res: Response): Promise<void> {
  const { customerLat, customerLng, cartSubtotal, fulfillmentType } = req.body as {
    customerLat?: number;
    customerLng?: number;
    cartSubtotal: number;
    fulfillmentType?: 'DELIVERY' | 'PICKUP';
  };
  const sub = await svc.loadSubscriptionContext(req.user?.userId);
  const result = await svc.quoteDelivery({
    customerLat,
    customerLng,
    cartSubtotal,
    fulfillmentType,
    ...sub,
  });
  ok(res, result);
}

export async function quote(req: AuthRequest, res: Response): Promise<void> {
  const { customerLat, customerLng, cartSubtotal, fulfillmentType } = req.body as {
    customerLat?: number;
    customerLng?: number;
    cartSubtotal?: number;
    fulfillmentType?: 'DELIVERY' | 'PICKUP';
  };
  const sub = await svc.loadSubscriptionContext(req.user?.userId);
  const result = await svc.quoteDelivery({
    customerLat,
    customerLng,
    cartSubtotal,
    fulfillmentType,
    ...sub,
  });
  ok(res, result);
}

export async function getBranch(_req: AuthRequest, res: Response): Promise<void> {
  const data = await svc.getBranch();
  ok(res, data);
}

const latLngSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
// A polygon ring needs >= 3 vertices. `null` clears it; omitting it leaves
// the stored value untouched.
const polygonSchema = z.array(latLngSchema).min(3);

const branchSchema = z.object({
  name: z.string().min(1),
  nameAr: z.string().min(1),
  address: z.string().min(1),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  phone: z.string().nullable().optional(),
  deliveryPolygon: polygonSchema.nullable().optional(),
  excludedPolygons: z.array(polygonSchema).nullable().optional(),
});

export async function upsertBranch(req: AuthRequest, res: Response): Promise<void> {
  try {
    const body = branchSchema.parse(req.body);
    const data = await svc.upsertBranch(body);
    ok(res, data, 'Branch saved.');
  } catch (err) {
    badRequest(res, (err as Error).message);
  }
}

export async function getSettings(_req: AuthRequest, res: Response): Promise<void> {
  const data = await svc.getDeliverySettings();
  ok(res, data);
}

/**
 * Single contract for `PUT /api/delivery/settings`. Whitelists only the
 * fields that `quoteDelivery` actually reads. Anything else (legacy
 * `distancePricingEnabled`, `feePerKm`, `minimumFee`, `maximumFee`,
 * `thresholdForSubscribers`) is stripped by Zod's default `.strip()`
 * behavior — the legacy `/admin/settings` page keeps working but its
 * writes to dead fields become no-ops, so `/admin/branch-coverage`
 * remains the single source of truth for delivery configuration.
 */
const updateSettingsSchema = z.object({
  // Coverage gates
  deliveryEnabled: z.boolean().optional(),
  maxDeliveryKm: z.number().positive().nullable().optional(),
  // Distance pricing
  distanceRulesEnabled: z.boolean().optional(),
  roadDistanceMultiplier: z.number().min(0.5).max(3).optional(),
  // Subscription baseline (read on the subscription path only)
  baseFee: z.number().min(0).optional(),
  // Free-delivery threshold (non-subscriber path)
  freeDeliveryEnabled: z.boolean().optional(),
  freeDeliveryThreshold: z.number().min(0).nullable().optional(),
  thresholdForNonSubscribers: z.boolean().optional(),
});

export async function updateSettings(req: AuthRequest, res: Response): Promise<void> {
  try {
    const parsed = updateSettingsSchema.parse(req.body);
    const data = await svc.updateDeliverySettings(parsed);
    ok(res, data);
  } catch (err) {
    badRequest(res, (err as Error).message);
  }
}

export async function getMinimumOrder(_req: AuthRequest, res: Response): Promise<void> {
  const data = await svc.getMinimumOrderSettings();
  ok(res, data);
}

export async function updateMinimumOrder(req: AuthRequest, res: Response): Promise<void> {
  const data = await svc.updateMinimumOrderSettings(req.body);
  ok(res, data);
}

const rulesSchema = z.object({
  rules: z.array(
    z.object({
      minKm: z.number().min(0),
      maxKm: z.number().min(0).nullable(),
      fee: z.number().min(0),
      outOfService: z.boolean(),
      discountPercent: z.number().min(0).max(100).nullable().optional(),
      discountStartDate: z.string().nullable().optional(),
      discountEndDate: z.string().nullable().optional(),
      basketThreshold: z.number().min(0).nullable().optional(),
      feeAboveThreshold: z.number().min(0).nullable().optional(),
    }),
  ),
});

export async function getDistanceRules(_req: AuthRequest, res: Response): Promise<void> {
  const data = await svc.listDistanceRules();
  ok(res, data);
}

export async function replaceDistanceRules(req: AuthRequest, res: Response): Promise<void> {
  try {
    const body = rulesSchema.parse(req.body);
    const data = await svc.replaceDistanceRules(body.rules);
    ok(res, data, `Saved ${data.length} rule(s).`);
  } catch (err) {
    badRequest(res, (err as Error).message);
  }
}
