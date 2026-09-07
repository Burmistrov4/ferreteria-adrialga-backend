import { Router } from 'express';
import { getEstadoCaja, abrirCaja, cerrarCaja } from '../controllers/caja.controllers';
import { authenticateToken } from '../middlewares/auth.middleware';

const router = Router();

// Todas las operaciones de caja requieren autenticación.
router.use(authenticateToken);

router.get('/estado', getEstadoCaja);
router.post('/abrir', abrirCaja);
router.post('/cerrar', cerrarCaja);

export default router;