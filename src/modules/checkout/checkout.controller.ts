import { Response } from 'express';
import { z } from 'zod';
import { AuthRequest } from '../../middleware/auth.middleware';
import { ok, badRequest } from '../../lib/response';
import { quoteDelivery, loadSubscriptionContext } from '../delivery/delivery.service';

const calculateSchema = z.object({
  customerLatitude: z.number().min(-90).max(90).nullable().optional(),
  customerLongitude: z.number().min(-180).max(180).nullable().optional(),
  customerSubscriptionStatus: z
    .enum(['ACTIVE', 'NONE', 'EXPIRED', 'PENDING_PAYMENT', 'CANCELLED'])
    .nullable()
    .optional(),
  selectedFulfillmentType: z.enum(['DELIVERY', 'PICKUP']).nullable().optional(),
  cartSubtotal: z.number().nonnegative().nullable().optional(),
});

/**
 * Single source of truth for the customer-facing checkout. Returns whatever
 * fulfillment options are actually allowed RIGHT NOW (`availableFulfillmentTypes`),
 * the calculated distance, the matched pricing range, and the fee.
 *
 * Subscription status is reported by the client but cross-checked server-side
 * against the customer's actual ACTIVE subscription so a forged client value
 * can't unlock free delivery.
 */
export async function calculateDelivery(req: AuthRequest, res: Response): Promise<void> {
  try {
    const body = calculateSchema.parse(req.body);

    // Phase 3: subscription context resolution moved to the shared
    // helper so cart, checkout, and order creation all decide identically.
    // Authenticated users get the real subscription. Anonymous users that
    // claim ACTIVE are honoured but get no benefit params, which means
    // the calc treats them as FREE_DELIVERY (fee 0) at most — the same
    // pre-Phase-3 behavior.
    let subContext = await loadSubscriptionContext(req.user?.userId);
    if (!req.user && body.customerSubscriptionStatus === 'ACTIVE') {
      subContext = { ...subContext, hasActiveSubscription: true };
    }

    // PICKUP→fee 0 is now applied inside `quoteDelivery` itself, so
    // there's no separate "effective fee" calculation here.
    const selected = body.selectedFulfillmentType ?? null;
    const quote = await quoteDelivery({
      customerLat: body.customerLatitude ?? undefined,
      customerLng: body.customerLongitude ?? undefined,
      cartSubtotal: body.cartSubtotal ?? undefined,
      fulfillmentType: selected ?? undefined,
      ...subContext,
    });

    ok(res, {
      distanceKm: quote.distanceKm,
      isWithinDeliveryRange: quote.withinRange,
      deliveryAvailable: quote.deliveryAvailable,
      pickupAvailable: quote.pickupAvailable,
      deliveryFee: quote.fee,
      matchedDistanceRule: quote.matchedRule,
      availableFulfillmentTypes: quote.availableFulfillmentTypes,
      selectedFulfillmentType: selected,
      hasActiveSubscription: quote.hasActiveSubscription,
      pricingRuleApplied: quote.pricingRuleApplied,
      branchConfigured: quote.branchConfigured,
      maxDeliveryKm: quote.maxDeliveryKm,
      reason: quote.reason,
      message: quote.message,
    });
  } catch (err) {
    badRequest(res, (err as Error).message);
  }
}
