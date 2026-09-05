import { Router } from 'express';
import { getDashboardMetrics, getSerieFinanciera, exportarLibroDiario } from '../controllers/dashboard.controllers';
import { authenticateToken } from '../middlewares/auth.middleware';

const router = Router();

router.use(authenticateToken);
router.get('/', getDashboardMetrics);
router.get('/serie', getSerieFinanciera);
router.get('/exportar', exportarLibroDiario);

export default router;