import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler';
import { authenticateCustomer, authenticateStaff } from '../../middleware/auth.middleware';
import { ok, created, badRequest } from '../../lib/response';
import * as svc from './subscription.service';
import { AuthRequest } from '../../middleware/auth.middleware';

const router = Router();

// Public
router.get('/plans', asyncHandler(async (_req, res) => {
  ok(res, await svc.getPlans());
}));

router.get('/eligibility', asyncHandler(async (req, res) => {
  // lat/lng arrive as query strings — coerce to numbers, ignoring NaN.
  const lat = typeof req.query.lat === 'string' ? Number(req.query.lat) : undefined;
  const lng = typeof req.query.lng === 'string' ? Number(req.query.lng) : undefined;
  const data = await svc.getSubscriptionEligibility(
    Number.isFinite(lat ?? NaN) ? lat : undefined,
    Number.isFinite(lng ?? NaN) ? lng : undefined,
  );
  ok(res, data);
}));

// Customer
router.post('/subscribe', authenticateCustomer, asyncHandler(async (req: AuthRequest, res) => {
  try {
    const { planId, paymentMethod, customerLat, customerLng } = req.body as {
      planId: string;
      paymentMethod: string;
      customerLat?: number;
      customerLng?: number;
    };
    const sub = await svc.subscribeToPlan(req.user!.userId, planId, paymentMethod, {
      customerLat,
      customerLng,
    });
    created(res, sub, 'Subscription request submitted. Awaiting payment confirmation.');
  } catch (err) {
    badRequest(res, (err as Error).message);
  }
}));

router.get('/my', authenticateCustomer, asyncHandler(async (req: AuthRequest, res) => {
  const sub = await svc.getActiveSubscription(req.user!.userId);
  ok(res, sub);
}));

router.delete('/cancel', authenticateCustomer, asyncHandler(async (req: AuthRequest, res) => {
  await svc.cancelSubscription(req.user!.userId);
  ok(res, null, 'Subscription cancelled');
}));

// Admin (staff only)
router.get('/admin/plans', authenticateStaff, asyncHandler(async (_req, res) => {
  // Admin view always includes subscriber counts so the UI can render
  // "X subscribers" + gate the deactivate toggle.
  ok(res, await svc.getPlans(false, true));
}));

router.post('/admin/plans', authenticateStaff, asyncHandler(async (req, res) => {
  const data = await svc.createPlan(req.body);
  created(res, data);
}));

router.put('/admin/plans/:id', authenticateStaff, asyncHandler(async (req, res) => {
  ok(res, await svc.updatePlan(req.params.id, req.body));
}));

router.patch('/admin/plans/:id/status', authenticateStaff, asyncHandler(async (req, res) => {
  try {
    ok(res, await svc.togglePlan(req.params.id, req.body.isActive));
  } catch (err) {
    badRequest(res, (err as Error).message);
  }
}));

router.get('/admin/subscribers', authenticateStaff, asyncHandler(async (req, res) => {
  const page = typeof req.query.page === 'string' ? parseInt(req.query.page) || 1 : 1;
  const status = typeof req.query.status === 'string'
    ? (req.query.status as 'PENDING_PAYMENT' | 'ACTIVE' | 'EXPIRED' | 'CANCELLED')
    : undefined;
  const planId = typeof req.query.planId === 'string' ? req.query.planId : undefined;
  const data = await svc.listSubscribers({ page, status, planId });
  ok(res, data);
}));

router.patch('/admin/:id/confirm', authenticateStaff, asyncHandler(async (req: AuthRequest, res) => {
  const data = await svc.confirmSubscription(req.params.id, req.user!.userId);
  ok(res, data, 'Subscription activated');
}));

/**
 * Admin-side cancel: remove a specific customer from their plan. Used by
 * the admin Subscribers tab's per-row "Remove" action.
 */
router.delete('/admin/:id', authenticateStaff, asyncHandler(async (req: AuthRequest, res) => {
  try {
    const data = await svc.cancelSubscriptionById(req.params.id, req.user!.userId);
    ok(res, data, 'Subscription cancelled');
  } catch (err) {
    badRequest(res, (err as Error).message);
  }
}));

export default router;
