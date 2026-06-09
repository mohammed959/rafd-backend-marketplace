import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler';
import { authenticateStaff } from '../../middleware/auth.middleware';
import * as ctrl from './brand.controller';

const router = Router();

// Public reads — the customer storefront will display a brand chip on
// product cards in a later phase.
router.get('/', asyncHandler(ctrl.list));
router.get('/:id', asyncHandler(ctrl.getOne));

// Staff-only writes — the admin UI for managing brands lands in a later
// phase, but the endpoints are ready.
router.post('/',    authenticateStaff, asyncHandler(ctrl.create));
router.put('/:id',  authenticateStaff, asyncHandler(ctrl.update));
router.delete('/:id', authenticateStaff, asyncHandler(ctrl.remove));

export default router;
