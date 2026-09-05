// adrialga-backend/src/routes/scraping.routes.ts
import { Router } from 'express';
import { getTasaBCV, sincronizarPrecios } from '../controllers/scraping.controllers';
import { authenticateToken } from '../middlewares/auth.middleware';

const router = Router();

// Todas las rutas de scraping requieren sesión JWT válida
router.use(authenticateToken);

router.get('/bcv', getTasaBCV);
router.post('/sincronizar-precios', sincronizarPrecios);

export default router;
