import { prisma } from '../../lib/prisma';
import { quoteDelivery } from '../delivery/delivery.service';
import { logAction } from '../audit/audit.service';

export interface SubscriptionEligibility {
  eligible: boolean;
  hasLocation: boolean;
  distanceKm: number | null;
  maxDeliveryKm: number | null;
  branchConfigured: boolean;
  message?: string;
}

/**
 * Subscription plans are only offered when the customer's location is within
 * the admin-configured max delivery distance. Pickup is always available, but
 * subscriptions are a delivery benefit so they don't make sense out of range.
 *
 * Passing only one of lat/lng (or neither) reports `hasLocation: false` — the
 * frontend prompts the customer to choose a location first.
 */
export async function getSubscriptionEligibility(
  customerLat?: number,
  customerLng?: number,
): Promise<SubscriptionEligibility> {
  const quote = await quoteDelivery({ customerLat, customerLng });
  const hasLocation = customerLat != null && customerLng != null;
  if (!quote.branchConfigured) {
    return {
      eligible: false,
      hasLocation,
      distanceKm: null,
      maxDeliveryKm: quote.maxDeliveryKm,
      branchConfigured: false,
      message: 'Subscription plans are not available — the marketplace is still being set up.',
    };
  }
  if (!hasLocation) {
    return {
      eligible: false,
      hasLocation: false,
      distanceKm: null,
      maxDeliveryKm: quote.maxDeliveryKm,
      branchConfigured: true,
      message: 'Choose your location first to check subscription availability.',
    };
  }
  if (!quote.withinRange) {
    return {
      eligible: false,
      hasLocation: true,
      distanceKm: quote.distanceKm,
      maxDeliveryKm: quote.maxDeliveryKm,
      branchConfigured: true,
      message: 'Subscription is not available because your location is outside our delivery coverage.',
    };
  }
  return {
    eligible: true,
    hasLocation: true,
    distanceKm: quote.distanceKm,
    maxDeliveryKm: quote.maxDeliveryKm,
    branchConfigured: true,
  };
}

export async function getPlans(activeOnly = true, withSubscriberCount = false) {
  const plans = await prisma.subscriptionPlan.findMany({
    where: activeOnly ? { isActive: true } : {},
    orderBy: { price: 'asc' },
  });
  if (!withSubscriberCount || plans.length === 0) return plans;

  // Counts of ACTIVE + PENDING_PAYMENT subscribers per plan. We compute
  // this with a single groupBy rather than a per-plan COUNT(*), so adding
  // 100 plans doesn't fan out into 100 queries.
  const counts = await prisma.customerSubscription.groupBy({
    by: ['planId'],
    where: {
      planId: { in: plans.map((p) => p.id) },
      status: { in: ['ACTIVE', 'PENDING_PAYMENT'] as const },
    },
    _count: { _all: true },
  });
  const countByPlan = new Map(counts.map((c) => [c.planId, c._count._all]));
  return plans.map((p) => ({
    ...p,
    activeSubscriberCount: countByPlan.get(p.id) ?? 0,
  }));
}

export async function countActiveSubscribersForPlan(planId: string): Promise<number> {
  return prisma.customerSubscription.count({
    where: { planId, status: { in: ['ACTIVE', 'PENDING_PAYMENT'] as const } },
  });
}

export async function getPlanById(id: string) {
  return prisma.subscriptionPlan.findUnique({ where: { id } });
}

export async function createPlan(data: {
  name: string;
  nameAr: string;
  price: number;
  durationDays: number;
  benefitType: 'FREE_DELIVERY' | 'DISCOUNTED_DELIVERY' | 'CAPPED_DELIVERY';
  discountValue?: number;
  cappedFee?: number;
  maxFreeDeliveries?: number;
}) {
  return prisma.subscriptionPlan.create({ data });
}

export async function updatePlan(id: string, data: object) {
  return prisma.subscriptionPlan.update({ where: { id }, data });
}

/**
 * Toggle a plan's active flag. Deactivating is rejected when ACTIVE or
 * PENDING_PAYMENT subscribers still reference the plan — the admin must
 * cancel each subscriber first via `cancelSubscriptionById`. Activating
 * is always allowed.
 */
export async function togglePlan(id: string, isActive: boolean) {
  if (!isActive) {
    const subscriberCount = await countActiveSubscribersForPlan(id);
    if (subscriberCount > 0) {
      throw new Error(
        `Cannot deactivate this plan — ${subscriberCount} customer${
          subscriberCount === 1 ? '' : 's'
        } still subscribed. Remove ${
          subscriberCount === 1 ? 'them' : 'all of them'
        } from the plan first.`,
      );
    }
  }
  return prisma.subscriptionPlan.update({ where: { id }, data: { isActive } });
}

export async function subscribeToPlan(
  customerId: string,
  planId: string,
  paymentMethod: string,
  location?: { customerLat?: number; customerLng?: number },
) {
  const plan = await prisma.subscriptionPlan.findUnique({ where: { id: planId } });
  if (!plan || !plan.isActive) throw new Error('Plan not available');

  // Distance gate — both for explicit lat/lng and the customer's default
  // saved address. If neither resolves to coords inside coverage, refuse.
  let lat = location?.customerLat;
  let lng = location?.customerLng;
  if (lat == null || lng == null) {
    const defaultAddr = await prisma.customerAddress.findFirst({
      where: { customerId, isDefault: true },
      select: { latitude: true, longitude: true },
    });
    if (defaultAddr) {
      lat = Number(defaultAddr.latitude);
      lng = Number(defaultAddr.longitude);
    }
  }
  const eligibility = await getSubscriptionEligibility(lat, lng);
  if (!eligibility.eligible) {
    throw new Error(
      eligibility.message ?? 'Subscription is not available for your location.',
    );
  }

  const existing = await prisma.customerSubscription.findUnique({ where: { customerId } });
  if (existing && existing.status === 'ACTIVE') {
    throw new Error('You already have an active subscription');
  }

  const startDate = new Date();
  const expiryDate = new Date();
  expiryDate.setDate(expiryDate.getDate() + plan.durationDays);

  const data = {
    planId,
    startDate,
    expiryDate,
    status: 'PENDING_PAYMENT' as const,
    paymentMethod,
  };

  if (existing) {
    return prisma.customerSubscription.update({ where: { customerId }, data });
  }
  return prisma.customerSubscription.create({ data: { ...data, customerId } });
}

export async function getActiveSubscription(customerId: string) {
  return prisma.customerSubscription.findFirst({
    where: {
      customerId,
      status: 'ACTIVE',
      expiryDate: { gt: new Date() },
    },
    include: { plan: true },
  });
}

export async function confirmSubscription(subscriptionId: string, adminId: string) {
  return prisma.customerSubscription.update({
    where: { id: subscriptionId },
    data: {
      status: 'ACTIVE',
      adminConfirmedAt: new Date(),
      adminConfirmedBy: adminId,
    },
  });
}

export async function cancelSubscription(customerId: string) {
  return prisma.customerSubscription.updateMany({
    where: { customerId, status: { in: ['ACTIVE', 'PENDING_PAYMENT'] } },
    data: { status: 'CANCELLED' },
  });
}

/**
 * Admin-side: cancel one specific subscription by id (not by customer).
 * Required so the admin can remove every subscriber off a plan before
 * deactivating it. Audit-logs the action with the affected customer +
 * plan ids.
 */
export async function cancelSubscriptionById(subscriptionId: string, adminId: string) {
  const existing = await prisma.customerSubscription.findUnique({
    where: { id: subscriptionId },
    select: {
      id: true,
      status: true,
      customerId: true,
      planId: true,
      customer: { select: { mobile: true, name: true } },
    },
  });
  if (!existing) throw new Error('Subscription not found');
  if (existing.status !== 'ACTIVE' && existing.status !== 'PENDING_PAYMENT') {
    throw new Error('Subscription is already cancelled or expired');
  }
  await prisma.customerSubscription.update({
    where: { id: subscriptionId },
    data: { status: 'CANCELLED' },
  });
  await logAction({
    actorId: adminId,
    actorRole: 'SUPER_ADMIN',
    action: 'subscription.admin.cancel',
    entityType: 'customer_subscription',
    entityId: subscriptionId,
    changes: {
      customerId: existing.customerId,
      customerMobile: existing.customer.mobile,
      planId: existing.planId,
      previousStatus: existing.status,
    },
  });
  return { id: subscriptionId, status: 'CANCELLED' as const };
}

export async function listSubscribers(opts: {
  status?: 'PENDING_PAYMENT' | 'ACTIVE' | 'EXPIRED' | 'CANCELLED';
  planId?: string;
  page?: number;
  limit?: number;
} = {}) {
  const { status, planId, page = 1, limit = 20 } = opts;
  const where = {
    ...(status && { status }),
    ...(planId && { planId }),
  };
  const [subs, total] = await Promise.all([
    prisma.customerSubscription.findMany({
      where,
      skip: (page - 1) * limit,
      take: limit,
      include: {
        customer: { select: { id: true, name: true, mobile: true } },
        plan: { select: { id: true, name: true, benefitType: true, durationDays: true } },
      },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.customerSubscription.count({ where }),
  ]);
  return { subscriptions: subs, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
}
