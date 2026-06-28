import { Router } from 'express';
import { asyncHandler } from '../../middleware/asyncHandler';
import { authenticateStaff } from '../../middleware/auth.middleware';
import * as ctrl from './settings.controller';

const router = Router();

// Customer-facing read (homepage reads this without auth)
router.get('/home', asyncHandler(ctrl.getHome));

// Admin write (staff only)
router.put('/home', authenticateStaff, asyncHandler(ctrl.updateHome));

export default router;
