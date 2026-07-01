import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler';
import {
  authenticateCustomer,
  authenticateStaff,
  authenticateAny,
} from '../../middleware/auth.middleware';
import { authorize } from '../../middleware/rbac.middleware';
import * as ctrl from './order.controller';

const router = Router();

// Stats (admin)
router.get('/stats', authenticateStaff, asyncHandler(ctrl.dashboardStats));

// Admin My Orders — Today / Other / Future panels. Must come before /:id.
router.get('/admin/today',  authenticateStaff, asyncHandler(ctrl.adminListToday));
router.get('/admin/other',  authenticateStaff, asyncHandler(ctrl.adminListOther));
router.get('/admin/future', authenticateStaff, asyncHandler(ctrl.adminListFuture));

// Customer-only
router.get('/buy-again', authenticateCustomer, asyncHandler(ctrl.buyAgain));

// Mixed listing — controller shapes the result based on req.user.role.
router.get('/', authenticateAny, asyncHandler(ctrl.list));
router.get('/:id', authenticateAny, asyncHandler(ctrl.getOne));

// Customer creates / acts on their own order
router.post('/', authenticateCustomer, asyncHandler(ctrl.create));
router.post('/:id/reorder', authenticateCustomer, asyncHandler(ctrl.reorder));
router.post('/:id/cancel', authenticateCustomer, asyncHandler(ctrl.cancelOwn));
router.post('/:id/payment-proof', authenticateCustomer, asyncHandler(ctrl.uploadPaymentProof));
router.patch('/:id/delivery-images', authenticateCustomer, asyncHandler(ctrl.updateDeliveryImages));

// Optional curbside car details. Customer-scoped.
router.patch('/:id/car-pickup-details',
  authenticateCustomer,
  asyncHandler(ctrl.updateCarPickupDetails));
router.delete('/:id/car-pickup-details',
  authenticateCustomer,
  asyncHandler(ctrl.clearCarPickupDetails));

// Staff actions
router.patch('/:id/status', authenticateStaff, asyncHandler(ctrl.changeStatus));
router.patch('/:id/assign-picker', authenticateStaff, authorize('SUPER_ADMIN'), asyncHandler(ctrl.assignPicker));
router.patch('/:id/assign-driver', authenticateStaff, authorize('SUPER_ADMIN'), asyncHandler(ctrl.assignDriver));
router.patch('/:id/reject', authenticateStaff, authorize('SUPER_ADMIN'), asyncHandler(ctrl.reject));
router.patch('/:id/payment-verify', authenticateStaff, authorize('SUPER_ADMIN'), asyncHandler(ctrl.verifyPayment));

// Picker workflow
router.patch('/:id/items/:itemId/status',
  authenticateStaff, authorize('PICKER', 'SUPER_ADMIN'),
  asyncHandler(ctrl.setItemStatus)
);
router.post('/:id/items/:itemId/replace',
  authenticateStaff, authorize('PICKER', 'SUPER_ADMIN'),
  asyncHandler(ctrl.replaceItem)
);

export default router;
