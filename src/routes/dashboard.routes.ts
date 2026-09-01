import { Router } from 'express';
import { getDashboardMetrics, getSerieFinanciera } from '../controllers/dashboard.controllers';
import { authenticateToken } from '../middlewares/auth.middleware';

const router = Router();

router.use(authenticateToken);
router.get('/', getDashboardMetrics);
router.get('/serie', getSerieFinanciera);

export default router;