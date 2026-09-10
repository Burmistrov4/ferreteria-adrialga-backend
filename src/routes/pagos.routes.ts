import { Router } from 'express';
import { procesarPagoMixto } from '../controllers/pagos.controllers';
import { authenticateToken } from '../middlewares/auth.middleware';

const router = Router();

router.use(authenticateToken);
router.post('/procesar', procesarPagoMixto as any);

export default router;