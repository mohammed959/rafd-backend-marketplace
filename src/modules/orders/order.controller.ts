import { Response } from 'express';
import { AuthRequest } from '../../middleware/auth.middleware';
import * as svc from './order.service';
import {
  createOrderSchema,
  assignPickerSchema,
  assignDriverSchema,
  rejectOrderSchema,
  updateStatusSchema,
} from './order.schema';
import { ok, created, notFound, badRequest } from '../../lib/response';
import { OrderStatus, FulfillmentType } from '@prisma/client';

function qs(val: unknown): string | undefined {
  return typeof val === 'string' ? val : undefined;
}

export async function create(req: AuthRequest, res: Response): Promise<void> {
  const body = createOrderSchema.parse(req.body);
  try {
    const order = await svc.createOrder(req.user!.userId, body);
    created(res, order, 'Order placed successfully');
  } catch (err) {
    badRequest(res, (err as Error).message);
  }
}

export async function getOne(req: AuthRequest, res: Response): Promise<void> {
  const order = await svc.getOrderById(req.params.id);
  if (!order) { notFound(res, 'Order not found'); return; }

  // Ownership / scope enforcement. Treat unauthorised reads as 404 so that
  // we don't leak the existence of other customers' orders. The barcode is
  // part of this payload, so this single check guards the barcode too.
  const { role, userId } = req.user!;
  if (role === 'CUSTOMER' && order.customerId !== userId) {
    notFound(res, 'Order not found'); return;
  }
  if (role === 'PICKER' && order.pickerId !== userId) {
    notFound(res, 'Order not found'); return;
  }
  if (role === 'DRIVER' && order.driverId !== userId) {
    notFound(res, 'Order not found'); return;
  }
  // SUPER_ADMIN sees everything.

  // Drivers must never see the curbside-pickup details — those are picker
  // information for handing the order over at the branch.
  if (role === 'DRIVER') {
    const { carPlateNumber, carBrand, carColor, pickupCustomerNote, ...rest } =
      order as typeof order & {
        carPlateNumber?: string | null; carBrand?: string | null;
        carColor?: string | null; pickupCustomerNote?: string | null;
      };
    ok(res, rest);
    return;
  }

  ok(res, order);
}

export async function list(req: AuthRequest, res: Response): Promise<void> {
  const role = req.user!.role;
  const userId = req.user!.userId;

  // Drivers can never see pickup orders — those skip the delivery workflow.
  const fulfillmentType: FulfillmentType | undefined =
    role === 'DRIVER'
      ? 'DELIVERY'
      : (qs(req.query.fulfillmentType) as FulfillmentType | undefined);

  const result = await svc.listOrders({
    customerId: role === 'CUSTOMER' ? userId : qs(req.query.customerId),
    pickerId: role === 'PICKER' ? userId : qs(req.query.pickerId),
    driverId: role === 'DRIVER' ? userId : qs(req.query.driverId),
    status: qs(req.query.status) as OrderStatus | undefined,
    fulfillmentType,
    page: parseInt(qs(req.query.page) ?? '1') || 1,
    limit: parseInt(qs(req.query.limit) ?? '20') || 20,
  });

  ok(res, result);
}

// ─── Admin My Orders ─────────────────────────────────────────────────
// Two endpoints back the admin "My Orders" page:
//   GET /orders/admin/today  → orders created since 00:00 server time
//   GET /orders/admin/other  → orders strictly before 00:00 server time
// They are designed to never overlap (today excludes [00:00, +1d), other
// caps the upper bound at < 00:00 today, even if the admin asks for it).

function startOfServerDay(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + days);
  return out;
}

/**
 * Format a Date as YYYY-MM-DD in the server's local timezone. We must NOT
 * use `toISOString()` here — it returns UTC and shifts the calendar day
 * across midnight in non-UTC timezones, so the echoed `range` would not
 * match the day the admin actually queried.
 */
function localYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseYmd(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  // Accept YYYY-MM-DD; build a Date at local midnight.
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return undefined;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return undefined;
  d.setHours(0, 0, 0, 0);
  return d;
}

type PaymentStatusFilter = 'PENDING' | 'UNDER_REVIEW' | 'APPROVED' | 'REJECTED';

function commonAdminListInputs(req: AuthRequest) {
  return {
    customerId: qs(req.query.customerId),
    status: qs(req.query.status) as OrderStatus | undefined,
    paymentStatus: qs(req.query.paymentStatus) as PaymentStatusFilter | undefined,
    fulfillmentType: qs(req.query.fulfillmentType) as FulfillmentType | undefined,
    search: qs(req.query.search),
    page: parseInt(qs(req.query.page) ?? '1') || 1,
    limit: parseInt(qs(req.query.limit) ?? '20') || 20,
  };
}

// Effective-date helper: an order's "effective" date is its scheduledPickupDate
// when present, else its createdAt date. Today/Other/Future buckets all use
// this so a scheduled-for-today order placed yesterday belongs to Today.

export async function adminListToday(req: AuthRequest, res: Response): Promise<void> {
  const start = startOfServerDay();
  const end = addDays(start, 1);
  const result = await svc.listOrders({
    ...commonAdminListInputs(req),
    effectiveFrom: start,
    effectiveTo: end,
  });
  ok(res, result);
}

export async function adminListOther(req: AuthRequest, res: Response): Promise<void> {
  const startOfToday = startOfServerDay();

  // Default range: last 3 days, EXCLUDING today.
  const defaultFrom = addDays(startOfToday, -3);
  const defaultTo = startOfToday; // exclusive

  let effectiveFrom = parseYmd(qs(req.query.fromDate)) ?? defaultFrom;
  let parsedTo = parseYmd(qs(req.query.toDate));
  // toDate is inclusive for the user; convert to exclusive upper bound.
  let effectiveTo = parsedTo ? addDays(parsedTo, 1) : defaultTo;

  // Hard cap: Other Orders must never include today, even if the admin asks.
  if (effectiveTo.getTime() > startOfToday.getTime()) effectiveTo = startOfToday;
  if (effectiveFrom.getTime() >= effectiveTo.getTime()) {
    effectiveFrom = defaultFrom;
    effectiveTo = defaultTo;
  }

  const result = await svc.listOrders({
    ...commonAdminListInputs(req),
    effectiveFrom,
    effectiveTo,
  });
  ok(res, {
    ...result,
    range: {
      fromDate: localYmd(effectiveFrom),
      toDate: localYmd(addDays(effectiveTo, -1)),
    },
  });
}

export async function adminListFuture(req: AuthRequest, res: Response): Promise<void> {
  const startOfToday = startOfServerDay();
  const startOfTomorrow = addDays(startOfToday, 1);

  // Defaults: from tomorrow onward, no upper bound.
  let scheduledFrom = parseYmd(qs(req.query.fromDate)) ?? startOfTomorrow;
  const parsedTo = parseYmd(qs(req.query.toDate));
  let scheduledTo = parsedTo ? addDays(parsedTo, 1) : undefined;

  // Hard floor: Future Orders must always be strictly after today.
  if (scheduledFrom.getTime() < startOfTomorrow.getTime()) scheduledFrom = startOfTomorrow;
  if (scheduledTo && scheduledTo.getTime() <= scheduledFrom.getTime()) {
    scheduledTo = addDays(scheduledFrom, 30);
  }

  const result = await svc.listOrders({
    ...commonAdminListInputs(req),
    fulfillmentType: 'PICKUP',
    scheduledFrom,
    scheduledTo,
    scheduledPickupSlotId: qs(req.query.pickupSlotId),
    orderBy: 'scheduledPickupAsc',
  });
  ok(res, {
    ...result,
    range: {
      fromDate: localYmd(scheduledFrom),
      toDate: scheduledTo ? localYmd(addDays(scheduledTo, -1)) : null,
    },
  });
}

export async function changeStatus(req: AuthRequest, res: Response): Promise<void> {
  const { status, note } = updateStatusSchema.parse(req.body);
  const order = await svc.updateOrderStatus(req.params.id, status, req.user!.userId, note);
  ok(res, order);
}

export async function assignPicker(req: AuthRequest, res: Response): Promise<void> {
  const { pickerId } = assignPickerSchema.parse(req.body);
  const order = await svc.assignPicker(req.params.id, pickerId, req.user!.userId);
  ok(res, order);
}

export async function assignDriver(req: AuthRequest, res: Response): Promise<void> {
  const { driverId } = assignDriverSchema.parse(req.body);
  const order = await svc.assignDriver(req.params.id, driverId, req.user!.userId);
  ok(res, order);
}

export async function reject(req: AuthRequest, res: Response): Promise<void> {
  const { reason } = rejectOrderSchema.parse(req.body);
  const order = await svc.rejectOrder(req.params.id, reason, req.user!.userId);
  ok(res, order);
}

export async function dashboardStats(req: AuthRequest, res: Response): Promise<void> {
  const stats = await svc.getDashboardStats();
  ok(res, stats);
}

export async function buyAgain(req: AuthRequest, res: Response): Promise<void> {
  const data = await svc.getBuyAgainProducts(req.user!.userId);
  ok(res, data);
}

export async function cancelOwn(req: AuthRequest, res: Response): Promise<void> {
  const { reason } = (req.body ?? {}) as { reason?: string };
  try {
    const data = await svc.cancelOwnOrder(req.user!.userId, req.params.id, reason);
    ok(res, data, 'Order cancelled');
  } catch (err) {
    badRequest(res, (err as Error).message);
  }
}

const CAR_FIELDS = ['carPlateNumber', 'carBrand', 'carColor', 'pickupCustomerNote'] as const;
type CarField = (typeof CAR_FIELDS)[number];
const MAX_FIELD_LEN = { carPlateNumber: 32, carBrand: 64, carColor: 32, pickupCustomerNote: 500 } as const;

export async function updateCarPickupDetails(req: AuthRequest, res: Response): Promise<void> {
  const body = (req.body ?? {}) as Partial<Record<CarField, unknown>>;
  const input: Record<CarField, string | null | undefined> = {
    carPlateNumber: undefined, carBrand: undefined, carColor: undefined, pickupCustomerNote: undefined,
  };

  for (const field of CAR_FIELDS) {
    const raw = body[field];
    if (raw === undefined) continue;
    if (raw === null) { input[field] = null; continue; }
    if (typeof raw !== 'string') {
      badRequest(res, `${field} must be a string or null`); return;
    }
    if (raw.length > MAX_FIELD_LEN[field]) {
      badRequest(res, `${field} must be at most ${MAX_FIELD_LEN[field]} characters`); return;
    }
    input[field] = raw;
  }

  try {
    const order = await svc.updateCarPickupDetails(req.user!.userId, req.params.id, input);
    ok(res, order, 'Car pickup details saved');
  } catch (err) {
    badRequest(res, (err as Error).message);
  }
}

export async function clearCarPickupDetails(req: AuthRequest, res: Response): Promise<void> {
  try {
    const order = await svc.clearCarPickupDetails(req.user!.userId, req.params.id);
    ok(res, order, 'Car pickup details cleared');
  } catch (err) {
    badRequest(res, (err as Error).message);
  }
}

export async function reorder(req: AuthRequest, res: Response): Promise<void> {
  try {
    const data = await svc.buildReorderCart(req.user!.userId, req.params.id);
    ok(res, data);
  } catch (err) {
    badRequest(res, (err as Error).message);
  }
}

export async function setItemStatus(req: AuthRequest, res: Response): Promise<void> {
  const status = (req.body?.status ?? '') as string;
  if (!['PICKED', 'UNAVAILABLE', 'REMOVED'].includes(status)) {
    badRequest(res, "status must be PICKED, UNAVAILABLE, or REMOVED");
    return;
  }
  try {
    const data = await svc.setOrderItemStatus(
      req.params.id,
      req.params.itemId,
      status as 'PICKED' | 'UNAVAILABLE' | 'REMOVED',
      req.user!
    );
    ok(res, data);
  } catch (err) {
    badRequest(res, (err as Error).message);
  }
}

export async function replaceItem(req: AuthRequest, res: Response): Promise<void> {
  const { productId, quantity } = req.body as { productId?: string; quantity?: number };
  if (typeof productId !== 'string' || !productId) {
    badRequest(res, 'productId is required');
    return;
  }
  try {
    const data = await svc.replaceOrderItem(
      req.params.id,
      req.params.itemId,
      productId,
      typeof quantity === 'number' ? quantity : undefined,
      req.user!
    );
    ok(res, data);
  } catch (err) {
    badRequest(res, (err as Error).message);
  }
}

export async function verifyPayment(req: AuthRequest, res: Response): Promise<void> {
  const { approved, note } = req.body as { approved?: boolean; note?: string };
  if (typeof approved !== 'boolean') {
    badRequest(res, 'approved (boolean) is required');
    return;
  }
  try {
    const data = await svc.verifyPayment(req.params.id, approved, note, req.user!.userId);
    ok(res, data, approved ? 'Payment approved' : 'Payment rejected');
  } catch (err) {
    badRequest(res, (err as Error).message);
  }
}

const MAX_DELIVERY_IMAGES = 3;

export async function updateDeliveryImages(req: AuthRequest, res: Response): Promise<void> {
  const { images } = (req.body ?? {}) as { images?: unknown };
  if (!Array.isArray(images) || !images.every((i) => typeof i === 'string')) {
    badRequest(res, 'images must be an array of URLs');
    return;
  }
  if (images.length > MAX_DELIVERY_IMAGES) {
    badRequest(res, `A maximum of ${MAX_DELIVERY_IMAGES} images is allowed.`);
    return;
  }
  try {
    const data = await svc.updateDeliveryImages(req.user!.userId, req.params.id, images as string[]);
    ok(res, data, 'Delivery location images updated');
  } catch (err) {
    badRequest(res, (err as Error).message);
  }
}

export async function uploadPaymentProof(req: AuthRequest, res: Response): Promise<void> {
  const { proofUrl } = req.body as { proofUrl?: string };
  if (!proofUrl || typeof proofUrl !== 'string') {
    badRequest(res, 'proofUrl is required');
    return;
  }
  try {
    const data = await svc.attachPaymentProof(req.user!.userId, req.params.id, proofUrl);
    ok(res, data, 'Payment proof uploaded. Awaiting review.');
  } catch (err) {
    badRequest(res, (err as Error).message);
  }
}
