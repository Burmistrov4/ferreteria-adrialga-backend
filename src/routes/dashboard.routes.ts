import { Router } from 'express';
import {
  getDashboardMetrics,
  getSerieFinanciera,
  exportarLibroDiario,
  getNotificaciones,
} from '../controllers/dashboard.controllers';
import { authenticateToken } from '../middlewares/auth.middleware';

const router = Router();

router.use(authenticateToken);
router.get('/', getDashboardMetrics);
router.get('/serie', getSerieFinanciera);
router.get('/exportar', exportarLibroDiario);
// Centro de Notificaciones del Asistente de Negocio (Fase C).
router.get('/notificaciones', getNotificaciones);

export default router;