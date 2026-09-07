// adrialga-backend/src/routes/seniat.routes.ts
// Reportes fiscales SENIAT — protegidos por autenticación (solo encargado).
import { Router } from 'express';
import { getLibroVentas, getLibroCompras, getResumenIVA } from '../controllers/seniat.controllers';
import { authenticateToken } from '../middlewares/auth.middleware';

const router = Router();

router.use(authenticateToken);

router.get('/libro-ventas', getLibroVentas);
router.get('/libro-compras', getLibroCompras);
router.get('/resumen-iva', getResumenIVA);

export default router;