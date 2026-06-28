import { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import {
  LatLng,
  Polygon,
  normalizePolygon,
  normalizePolygons,
  pointInPolygon,
  pointInAnyPolygon,
  isPolygonInsidePolygon,
} from '../../lib/geo';

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export interface DeliveryQuoteResult {
  branchConfigured: boolean;
  deliveryEnabled: boolean;
  /** Distance used for rule matching: straight-line × roadDistanceMultiplier. */
  distanceKm: number | null;
  /** Raw great-circle distance from the haversine formula, for transparency. */
  straightLineKm: number | null;
  /** Multiplier the admin set to approximate road distance. 1.00 = unchanged. */
  roadDistanceMultiplier: number;
  fee: number;
  /** Home delivery is allowed for this customer. False ⇒ frontend must hide
   *  delivery and Cash-on-Delivery, and the backend will reject delivery orders. */
  deliveryAvailable: boolean;
  pickupAvailable: boolean;
  /** Legacy alias kept for older callers — mirrors deliveryAvailable. */
  withinRange: boolean;
  outOfService: boolean;
  reason:
    | 'FLAT'
    | 'DISTANCE'
    | 'RULE'
    | 'SUBSCRIPTION'
    | 'THRESHOLD'
    | 'OUT_OF_RANGE'
    | 'PICKUP_ONLY'
    | 'NO_LOCATION'
    | 'NO_RULES'
    | 'NO_BRANCH'
    // Polygon coverage outcomes (replace radius-based OUT_OF_RANGE):
    | 'OUT_OF_AREA'
    | 'IN_EXCLUDED_AREA'
    | 'AREA_NOT_CONFIGURED';
  matchedRule: {
    id: string;
    minKm: number;
    maxKm: number | null;
    fee: number;
    outOfService: boolean;
    /** Was the basket-threshold override applied? */
    basketThresholdApplied: boolean;
    /** Was a date-windowed discount applied? */
    discountApplied: boolean;
    /** SAR amount knocked off by the discount (already reflected in `fee`). */
    discountAmount: number;
  } | null;
  maxDeliveryKm: number | null;
  /** True when the customer is within the max delivery distance — subscription
   *  plans can only be offered/used when this is true. */
  subscriptionEligible: boolean;
  /** Indicates which path priced the delivery fee. */
  pricingRuleApplied: 'NONE' | 'DISTANCE_RULE' | 'SUBSCRIPTION' | 'THRESHOLD' | 'PICKUP';
  hasActiveSubscription: boolean;
  /** Fulfillment types the customer can actually pick right now. */
  availableFulfillmentTypes: Array<'DELIVERY' | 'PICKUP'>;
  message?: string;
}

interface QuoteOpts {
  customerLat?: number;
  customerLng?: number;
  cartSubtotal?: number;
  /**
   * Phase 3: when the customer has selected PICKUP, the quote returns
   * `fee: 0` and `pricingRuleApplied: 'PICKUP'` — all other fields
   * (distance, branchConfigured, deliveryAvailable, etc.) are still
   * computed so the order/checkout layer can decide eligibility. When
   * omitted, the calc returns the delivery-fee semantics that the cart
   * has always shown.
   */
  fulfillmentType?: 'DELIVERY' | 'PICKUP';
  hasActiveSubscription?: boolean;
  subscriptionBenefitType?: string | null;
  subscriptionDiscountValue?: number | null;
  subscriptionCappedFee?: number | null;
}

/**
 * Phase 3: subscription context loader used by every backend caller of
 * `quoteDelivery` (cart fee endpoint, checkout quote endpoint, and
 * order creation). Centralising this lookup is what guarantees the
 * subscription decision is identical at every step — there is no longer
 * an inline `prisma.customerSubscription.findFirst` in three places.
 */
export interface SubscriptionContext {
  hasActiveSubscription: boolean;
  subscriptionBenefitType: string | null;
  subscriptionDiscountValue: number | null;
  subscriptionCappedFee: number | null;
}

export async function loadSubscriptionContext(customerId?: string): Promise<SubscriptionContext> {
  const empty: SubscriptionContext = {
    hasActiveSubscription: false,
    subscriptionBenefitType: null,
    subscriptionDiscountValue: null,
    subscriptionCappedFee: null,
  };
  if (!customerId) return empty;
  const sub = await prisma.customerSubscription.findFirst({
    where: { customerId, status: 'ACTIVE', expiryDate: { gt: new Date() } },
    include: { plan: { select: { benefitType: true, discountValue: true, cappedFee: true } } },
  });
  if (!sub) return empty;
  return {
    hasActiveSubscription: true,
    subscriptionBenefitType: sub.plan.benefitType,
    subscriptionDiscountValue: sub.plan.discountValue ? Number(sub.plan.discountValue) : null,
    subscriptionCappedFee: sub.plan.cappedFee ? Number(sub.plan.cappedFee) : null,
  };
}

/**
 * Compute distance + delivery fee + eligibility for a customer location.
 *
 * Source of truth for the delivery fee is the admin's distance-rule table —
 * there's no flat-fee fallback for non-subscribers. If the admin has not yet
 * configured `maxDeliveryKm` AND distance rules, home delivery is not offered.
 *
 * Decision order for non-subscribers within range:
 *   1. Free-delivery threshold        → fee 0  (only if enabled)
 *   2. Distance-rule table match      → that rule's fee
 *   No other fallback. Anything else ⇒ delivery unavailable.
 *
 * Subscribers within range bypass the distance-rule table entirely; their
 * plan's benefit is the only pricing decision.
 */
export async function quoteDelivery(opts: QuoteOpts): Promise<DeliveryQuoteResult> {
  const quote = await computeDeliveryQuote(opts);
  // Phase 3 single-path consolidation: when the customer (or order
  // creation flow) declares PICKUP, override the fee in one place rather
  // than at every caller. Eligibility fields stay intact so the order
  // layer's gates (branchConfigured / deliveryAvailable / etc.) still
  // behave as before.
  if (opts.fulfillmentType === 'PICKUP') {
    return { ...quote, fee: 0, pricingRuleApplied: 'PICKUP' };
  }
  return quote;
}

async function computeDeliveryQuote(opts: QuoteOpts): Promise<DeliveryQuoteResult> {
  const [settings, branch] = await Promise.all([
    prisma.deliveryPricingSettings.findFirst(),
    prisma.branch.findFirst({ where: { isActive: true } }),
  ]);

  const hasActiveSubscription = Boolean(opts.hasActiveSubscription);
  const rawMultiplier = settings?.roadDistanceMultiplier != null
    ? Number(settings.roadDistanceMultiplier)
    : 1;
  // Defensive: a non-positive or NaN multiplier would make every customer
  // look like they're at 0 km. Fall back to 1.0 (no adjustment).
  const roadDistanceMultiplier = Number.isFinite(rawMultiplier) && rawMultiplier > 0 ? rawMultiplier : 1;

  const baseQuote: DeliveryQuoteResult = {
    branchConfigured: Boolean(branch),
    deliveryEnabled: settings?.deliveryEnabled ?? true,
    distanceKm: null,
    straightLineKm: null,
    roadDistanceMultiplier,
    fee: 0,
    deliveryAvailable: false,
    pickupAvailable: true,
    withinRange: false,
    outOfService: false,
    reason: 'FLAT',
    matchedRule: null,
    maxDeliveryKm: settings?.maxDeliveryKm != null ? Number(settings.maxDeliveryKm) : null,
    subscriptionEligible: false,
    pricingRuleApplied: 'NONE',
    hasActiveSubscription,
    availableFulfillmentTypes: ['PICKUP'],
  };

  if (!branch) {
    return {
      ...baseQuote,
      pickupAvailable: false,
      availableFulfillmentTypes: [],
      reason: 'NO_BRANCH',
      message: 'Branch not configured.',
    };
  }
  if (!settings || !settings.deliveryEnabled) {
    return {
      ...baseQuote,
      reason: 'PICKUP_ONLY',
      message: settings ? 'Delivery is currently disabled. Only pickup is available.'
                        : 'Delivery has not been configured. Only pickup is available.',
    };
  }

  // ── Polygon-based coverage (replaces radius / maxDeliveryKm) ──────
  // The main delivery polygon defines the serviceable area; excluded
  // polygons carve out unreachable zones inside it. Distance is still
  // computed below, but ONLY for fee pricing (distance-rule tiers) — it no
  // longer decides whether delivery is available.
  const mainPolygon = normalizePolygon(branch.deliveryPolygon);
  const excludedPolygons = normalizePolygons(branch.excludedPolygons);

  if (!mainPolygon) {
    return {
      ...baseQuote,
      reason: 'AREA_NOT_CONFIGURED',
      message: 'Delivery area has not been configured yet. Pickup from Branch is available.',
    };
  }

  const hasCustomerCoords = opts.customerLat != null && opts.customerLng != null;
  let straightLineKm: number | null = null;
  let distanceKm: number | null = null;
  if (hasCustomerCoords) {
    const raw = haversineKm(
      opts.customerLat!,
      opts.customerLng!,
      Number(branch.latitude),
      Number(branch.longitude),
    );
    straightLineKm = Math.round(raw * 100) / 100;
    // Admin-controlled road-distance calibration — used for fee tiers only.
    distanceKm = Math.round(raw * roadDistanceMultiplier * 100) / 100;
  }

  baseQuote.distanceKm = distanceKm;
  baseQuote.straightLineKm = straightLineKm;

  if (distanceKm == null) {
    // No customer location yet — checkout will prompt for it.
    return {
      ...baseQuote,
      reason: 'NO_LOCATION',
      message: 'Choose a delivery location to see the fee.',
    };
  }

  const customerPoint: LatLng = { lat: opts.customerLat!, lng: opts.customerLng! };

  // Inside the main service area?
  if (!pointInPolygon(customerPoint, mainPolygon)) {
    return {
      ...baseQuote,
      reason: 'OUT_OF_AREA',
      outOfService: true,
      message:
        'Home delivery is not available for this location — it is outside the delivery area. Pickup from Branch is available.',
    };
  }

  // Inside an excluded (unreachable) zone?
  if (pointInAnyPolygon(customerPoint, excludedPolygons)) {
    return {
      ...baseQuote,
      reason: 'IN_EXCLUDED_AREA',
      outOfService: true,
      message:
        'Home delivery is not available for this location — it falls within an excluded area. Pickup from Branch is available.',
    };
  }

  // Inside coverage ⇒ subscribable and deliverable; the fee is decided below.
  baseQuote.subscriptionEligible = true;

  // SUBSCRIPTION PATH — bypass distance rules, apply the plan's benefit.
  if (hasActiveSubscription) {
    let fee = 0;
    if (opts.subscriptionBenefitType === 'DISCOUNTED_DELIVERY' && opts.subscriptionDiscountValue) {
      fee = Math.max(0, Number(settings.baseFee) - opts.subscriptionDiscountValue);
    } else if (opts.subscriptionBenefitType === 'CAPPED_DELIVERY' && opts.subscriptionCappedFee) {
      fee = Math.min(Number(settings.baseFee), opts.subscriptionCappedFee);
    }
    return {
      ...baseQuote,
      fee: parseFloat(fee.toFixed(2)),
      deliveryAvailable: true,
      withinRange: true,
      reason: 'SUBSCRIPTION',
      pricingRuleApplied: 'SUBSCRIPTION',
      availableFulfillmentTypes: ['DELIVERY', 'PICKUP'],
    };
  }

  // NON-SUBSCRIBER PATH — distance rules are the only pricing source.
  // Coverage is already satisfied (polygon), but we still need a configured
  // fee to charge. Without the distance-rule pricing toggle there's no fee
  // to apply, so delivery can't be offered to non-subscribers.
  if (!settings.distanceRulesEnabled) {
    return {
      ...baseQuote,
      reason: 'NO_RULES',
      message: 'Home delivery pricing is not configured yet. Pickup from Branch is available.',
    };
  }

  // (a) Free-delivery threshold short-circuit, if admin enabled it for non-subs.
  if (
    settings.freeDeliveryEnabled &&
    settings.freeDeliveryThreshold &&
    settings.thresholdForNonSubscribers &&
    opts.cartSubtotal != null &&
    opts.cartSubtotal >= Number(settings.freeDeliveryThreshold)
  ) {
    return {
      ...baseQuote,
      fee: 0,
      deliveryAvailable: true,
      withinRange: true,
      reason: 'THRESHOLD',
      pricingRuleApplied: 'THRESHOLD',
      availableFulfillmentTypes: ['DELIVERY', 'PICKUP'],
    };
  }

  // (b) Match against the distance-rule table.
  const rules = await prisma.deliveryDistanceRule.findMany({ orderBy: { sortOrder: 'asc' } });
  if (rules.length === 0) {
    return {
      ...baseQuote,
      reason: 'NO_RULES',
      message: 'Home delivery is not configured yet. Pickup from Branch is available.',
    };
  }

  let match = rules.find((r) => {
    const min = Number(r.minKm);
    const max = r.maxKm != null ? Number(r.maxKm) : Infinity;
    return distanceKm >= min && distanceKm < max;
  });

  // Coverage rule: the customer is within `maxDeliveryKm`, so home delivery
  // must be available. If their distance falls into a gap between ranges
  // (e.g. ranges 0–5 and 5–15 with maxDeliveryKm=20, customer at 18 km), fall
  // back to the deliverable range with the largest minKm ≤ distance — this
  // mirrors the admin's intent that anyone within max can still order.
  //
  // An explicit out-of-service hit is NOT softened — that's the admin marking
  // a range as a hard "no delivery" zone.
  if (!match) {
    const candidate = [...rules]
      .filter((r) => !r.outOfService && Number(r.minKm) <= distanceKm)
      .sort((a, b) => Number(b.minKm) - Number(a.minKm))[0];
    if (candidate) match = candidate;
  }

  if (!match || match.outOfService) {
    return {
      ...baseQuote,
      reason: 'OUT_OF_RANGE',
      outOfService: true,
      matchedRule: match
        ? {
            id: match.id,
            minKm: Number(match.minKm),
            maxKm: match.maxKm != null ? Number(match.maxKm) : null,
            fee: Number(match.fee),
            outOfService: true,
            basketThresholdApplied: false,
            discountApplied: false,
            discountAmount: 0,
          }
        : null,
      message: `Your location is ${distanceKm.toFixed(1)} km away — outside delivery coverage. Pickup from Branch is available.`,
    };
  }

  // 1. Pick the base fee. Basket-threshold override wins when BOTH the
  //    threshold and the override fee are configured AND the cart meets it.
  const basketThreshold = match.basketThreshold != null ? Number(match.basketThreshold) : null;
  const feeAboveThreshold = match.feeAboveThreshold != null ? Number(match.feeAboveThreshold) : null;
  const basketThresholdApplied =
    basketThreshold != null &&
    feeAboveThreshold != null &&
    opts.cartSubtotal != null &&
    opts.cartSubtotal >= basketThreshold;
  let baseFee = basketThresholdApplied ? feeAboveThreshold! : Number(match.fee);

  // 2. Optionally apply a percentage discount when "now" is in window.
  //    A missing start/end bound leaves that end open.
  const now = new Date();
  const discountPercent = match.discountPercent != null ? Number(match.discountPercent) : null;
  const inDiscountWindow =
    discountPercent != null &&
    discountPercent > 0 &&
    (match.discountStartDate == null || now >= match.discountStartDate) &&
    (match.discountEndDate == null || now <= match.discountEndDate);
  let discountAmount = 0;
  if (inDiscountWindow) {
    discountAmount = (baseFee * discountPercent!) / 100;
    baseFee = Math.max(0, baseFee - discountAmount);
  }

  return {
    ...baseQuote,
    fee: parseFloat(baseFee.toFixed(2)),
    deliveryAvailable: true,
    withinRange: true,
    reason: 'RULE',
    pricingRuleApplied: 'DISTANCE_RULE',
    matchedRule: {
      id: match.id,
      minKm: Number(match.minKm),
      maxKm: match.maxKm != null ? Number(match.maxKm) : null,
      fee: Number(match.fee),
      outOfService: false,
      basketThresholdApplied,
      discountApplied: inDiscountWindow,
      discountAmount: parseFloat(discountAmount.toFixed(2)),
    },
    availableFulfillmentTypes: ['DELIVERY', 'PICKUP'],
  };
}

/** Legacy entry point kept for callers that only need the fee shape. */
export async function calculateDeliveryFee(opts: QuoteOpts) {
  const q = await quoteDelivery(opts);
  return { fee: q.fee, distanceKm: q.distanceKm, reason: q.reason };
}

// ─── Branch ────────────────────────────────────────────────────────

export async function getBranch() {
  const branch = await prisma.branch.findFirst({ where: { isActive: true } });
  if (!branch) {
    return {
      configured: false,
      branch: null,
    };
  }
  return {
    configured: true,
    branch: {
      id: branch.id,
      name: branch.name,
      nameAr: branch.nameAr,
      address: branch.address,
      latitude: Number(branch.latitude),
      longitude: Number(branch.longitude),
      phone: branch.phone,
      deliveryPolygon: normalizePolygon(branch.deliveryPolygon),
      excludedPolygons: normalizePolygons(branch.excludedPolygons),
    },
  };
}

export interface UpsertBranchInput {
  name: string;
  nameAr: string;
  address: string;
  latitude: number;
  longitude: number;
  phone?: string | null;
  /** Main delivery service area. `null` clears it (delivery becomes
   *  unavailable). `undefined` leaves the stored value untouched. */
  deliveryPolygon?: LatLng[] | null;
  /** Excluded zones inside the main area. */
  excludedPolygons?: LatLng[][] | null;
}

/**
 * Validate and normalize the polygon payload, returning the Prisma `data`
 * fields to write. Throws on malformed geometry so the controller can turn
 * it into a 400. Excluded rings must sit inside the main polygon.
 */
function buildPolygonData(input: UpsertBranchInput): {
  deliveryPolygon?: Prisma.InputJsonValue | typeof Prisma.JsonNull;
  excludedPolygons?: Prisma.InputJsonValue | typeof Prisma.JsonNull;
} {
  const data: {
    deliveryPolygon?: Prisma.InputJsonValue | typeof Prisma.JsonNull;
    excludedPolygons?: Prisma.InputJsonValue | typeof Prisma.JsonNull;
  } = {};

  // Main polygon: undefined = leave as-is; null/empty = clear; array = set.
  let mainPolygon: Polygon | null = null;
  if (input.deliveryPolygon !== undefined) {
    if (input.deliveryPolygon === null || input.deliveryPolygon.length === 0) {
      data.deliveryPolygon = Prisma.JsonNull;
    } else {
      const normalized = normalizePolygon(input.deliveryPolygon);
      if (!normalized) {
        throw new Error('Delivery area must be a polygon with at least 3 points.');
      }
      mainPolygon = normalized;
      data.deliveryPolygon = normalized as unknown as Prisma.InputJsonValue;
    }
  }

  // Excluded polygons: each must be a valid ring inside the main polygon.
  if (input.excludedPolygons !== undefined) {
    if (input.excludedPolygons === null || input.excludedPolygons.length === 0) {
      data.excludedPolygons = Prisma.JsonNull;
    } else {
      const rings: Polygon[] = [];
      for (const [i, raw] of input.excludedPolygons.entries()) {
        const ring = normalizePolygon(raw);
        if (!ring) {
          throw new Error(`Excluded area ${i + 1} must be a polygon with at least 3 points.`);
        }
        if (mainPolygon && !isPolygonInsidePolygon(ring, mainPolygon)) {
          throw new Error(`Excluded area ${i + 1} must be fully inside the delivery area.`);
        }
        rings.push(ring);
      }
      data.excludedPolygons = rings as unknown as Prisma.InputJsonValue;
    }
  }

  return data;
}

export async function upsertBranch(input: UpsertBranchInput) {
  const polygonData = buildPolygonData(input);
  const existing = await prisma.branch.findFirst({ where: { isActive: true } });
  if (existing) {
    return prisma.branch.update({
      where: { id: existing.id },
      data: {
        name: input.name,
        nameAr: input.nameAr,
        address: input.address,
        latitude: input.latitude,
        longitude: input.longitude,
        phone: input.phone ?? null,
        ...polygonData,
      },
    });
  }
  return prisma.branch.create({
    data: {
      name: input.name,
      nameAr: input.nameAr,
      address: input.address,
      latitude: input.latitude,
      longitude: input.longitude,
      phone: input.phone ?? null,
      isActive: true,
      ...polygonData,
    },
  });
}

// ─── Delivery settings ────────────────────────────────────────────

export async function getDeliverySettings() {
  return prisma.deliveryPricingSettings.findFirst();
}

/**
 * Phase 2 source-of-truth note:
 *
 *   `/admin/branch-coverage` is the canonical admin location for delivery
 *   configuration. The fields below split into two groups:
 *
 *     LIVE — read by `quoteDelivery` and writable via the tightened
 *     controller schema in `delivery.controller.ts`:
 *       deliveryEnabled, maxDeliveryKm, distanceRulesEnabled,
 *       roadDistanceMultiplier, baseFee (subscription path only),
 *       freeDeliveryEnabled, freeDeliveryThreshold,
 *       thresholdForNonSubscribers.
 *
 *     DEAD — kept here ONLY because the underlying DB columns are
 *     NOT NULL without `@default`, so the first-ever create needs a
 *     value. The controller's Zod schema rejects any update path, so
 *     these stay frozen at the seed values forever and are scheduled
 *     for removal in Phase 5 (destructive `DROP COLUMN` migration):
 *       distancePricingEnabled, feePerKm, minimumFee, maximumFee,
 *       thresholdForSubscribers.
 */
const SETTINGS_DEFAULTS = {
  // ── LIVE (read by quoteDelivery) ─────────────────────────────────
  deliveryEnabled: true,
  distanceRulesEnabled: false,
  maxDeliveryKm: null as number | null,
  baseFee: 0,
  freeDeliveryEnabled: false,
  freeDeliveryThreshold: null as number | null,
  thresholdForNonSubscribers: true,
  roadDistanceMultiplier: 1,

  // ── DEAD (kept only for create-fallback; never updatable) ────────
  distancePricingEnabled: false,
  feePerKm: 0,
  minimumFee: 0,
  maximumFee: 999,
  thresholdForSubscribers: true,
};

/**
 * Whitelisted update shape — matches the Zod schema in
 * `delivery.controller.ts`. Callers other than the controller (currently
 * none) must conform to this shape too.
 */
export interface UpdateDeliverySettingsInput {
  deliveryEnabled?: boolean;
  maxDeliveryKm?: number | null;
  distanceRulesEnabled?: boolean;
  roadDistanceMultiplier?: number;
  baseFee?: number;
  freeDeliveryEnabled?: boolean;
  freeDeliveryThreshold?: number | null;
  thresholdForNonSubscribers?: boolean;
}

export async function updateDeliverySettings(data: UpdateDeliverySettingsInput) {
  const existing = await prisma.deliveryPricingSettings.findFirst();
  if (existing) {
    return prisma.deliveryPricingSettings.update({
      where: { id: existing.id },
      data: data as Prisma.DeliveryPricingSettingsUpdateInput,
    });
  }
  return prisma.deliveryPricingSettings.create({
    data: { ...SETTINGS_DEFAULTS, ...data } as Prisma.DeliveryPricingSettingsCreateInput,
  });
}

// ─── Minimum order ────────────────────────────────────────────────

export async function getMinimumOrderSettings() {
  return prisma.minimumOrderSettings.findFirst();
}

export async function updateMinimumOrderSettings(data: object) {
  const existing = await prisma.minimumOrderSettings.findFirst();
  if (existing) {
    return prisma.minimumOrderSettings.update({ where: { id: existing.id }, data });
  }
  return prisma.minimumOrderSettings.create({ data: data as never });
}

// ─── Distance rules ───────────────────────────────────────────────

export interface DistanceRuleInput {
  minKm: number;
  maxKm: number | null;
  fee: number;
  outOfService: boolean;
  discountPercent?: number | null;
  discountStartDate?: string | null;
  discountEndDate?: string | null;
  basketThreshold?: number | null;
  feeAboveThreshold?: number | null;
}

export async function listDistanceRules() {
  return prisma.deliveryDistanceRule.findMany({ orderBy: { sortOrder: 'asc' } });
}

/**
 * Replace all distance rules in a single transaction. We require the caller
 * to pass the full ordered list — there's no per-row CRUD so admins can't
 * accidentally leave overlapping ranges in the table.
 */
export async function replaceDistanceRules(rules: DistanceRuleInput[]) {
  validateNoOverlap(rules);
  for (const [i, rule] of rules.entries()) {
    validateDiscountAndThreshold(rule, i);
  }
  return prisma.$transaction(async (tx) => {
    await tx.deliveryDistanceRule.deleteMany({});
    if (rules.length === 0) return [];
    return Promise.all(
      rules.map((rule, idx) =>
        tx.deliveryDistanceRule.create({
          data: {
            minKm: rule.minKm,
            maxKm: rule.maxKm,
            fee: rule.outOfService ? 0 : rule.fee,
            outOfService: rule.outOfService,
            discountPercent: rule.outOfService ? null : rule.discountPercent ?? null,
            discountStartDate: rule.outOfService ? null : parseOptionalDate(rule.discountStartDate),
            discountEndDate: rule.outOfService ? null : parseOptionalDate(rule.discountEndDate),
            basketThreshold: rule.outOfService ? null : rule.basketThreshold ?? null,
            feeAboveThreshold: rule.outOfService ? null : rule.feeAboveThreshold ?? null,
            sortOrder: idx,
          },
        }),
      ),
    );
  });
}

function parseOptionalDate(v: string | null | undefined): Date | null {
  if (v == null || v === '') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date: ${v}`);
  }
  return d;
}

function validateDiscountAndThreshold(rule: DistanceRuleInput, idx: number) {
  if (rule.outOfService) return;
  if (rule.discountPercent != null) {
    if (!Number.isFinite(rule.discountPercent) || rule.discountPercent < 0 || rule.discountPercent > 100) {
      throw new Error(`Rule ${idx + 1}: discount must be between 0 and 100 percent.`);
    }
  }
  if (
    rule.discountStartDate != null &&
    rule.discountEndDate != null &&
    rule.discountStartDate !== '' &&
    rule.discountEndDate !== ''
  ) {
    const start = new Date(rule.discountStartDate);
    const end = new Date(rule.discountEndDate);
    if (!Number.isNaN(start.getTime()) && !Number.isNaN(end.getTime()) && end < start) {
      throw new Error(`Rule ${idx + 1}: discount end date must be after start date.`);
    }
  }
  // Basket-threshold override: both halves must be set together. Set just one,
  // we silently treat the override as not configured (no error) — but warn the
  // admin via the response shape on read. To keep this explicit, refuse mixed.
  const hasThreshold = rule.basketThreshold != null;
  const hasFeeAbove = rule.feeAboveThreshold != null;
  if (hasThreshold !== hasFeeAbove) {
    throw new Error(
      `Rule ${idx + 1}: basket threshold and "fee above threshold" must both be filled to activate the override.`,
    );
  }
  if (hasThreshold) {
    if (!Number.isFinite(rule.basketThreshold!) || rule.basketThreshold! < 0) {
      throw new Error(`Rule ${idx + 1}: basket threshold must be ≥ 0.`);
    }
    if (!Number.isFinite(rule.feeAboveThreshold!) || rule.feeAboveThreshold! < 0) {
      throw new Error(`Rule ${idx + 1}: fee above threshold must be ≥ 0.`);
    }
  }
}

function validateNoOverlap(rules: DistanceRuleInput[]) {
  const sorted = [...rules].sort((a, b) => a.minKm - b.minKm);
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    if (!Number.isFinite(r.minKm) || r.minKm < 0) {
      throw new Error(`Rule ${i + 1}: minKm must be ≥ 0.`);
    }
    if (r.maxKm != null && r.maxKm <= r.minKm) {
      throw new Error(`Rule ${i + 1}: maxKm must be greater than minKm.`);
    }
    if (!r.outOfService && (!Number.isFinite(r.fee) || r.fee < 0)) {
      throw new Error(`Rule ${i + 1}: fee must be ≥ 0.`);
    }
    if (i > 0) {
      const prev = sorted[i - 1];
      const prevMax = prev.maxKm ?? Infinity;
      if (r.minKm < prevMax) {
        throw new Error(
          `Rules ${i} and ${i + 1} overlap (${prev.minKm}–${prev.maxKm ?? '∞'} km overlaps ${r.minKm}–${r.maxKm ?? '∞'} km).`,
        );
      }
    }
    if (i === sorted.length - 1) continue;
    if (r.maxKm == null) {
      throw new Error(`Rule ${i + 1} uses an open-ended range — only the last rule can omit maxKm.`);
    }
  }
}
