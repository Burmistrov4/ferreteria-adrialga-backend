import { Router } from 'express';
import { getDashboardMetrics } from '../controllers/dashboard.controllers';
import { authenticateToken } from '../middlewares/auth.middleware';

const router = Router();

router.use(authenticateToken);
router.get('/', getDashboardMetrics);

export default router;