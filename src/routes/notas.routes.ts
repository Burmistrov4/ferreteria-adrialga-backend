import { Router } from 'express';
import { getNotasEntrega, createNotaEntrega, reverseNotaEntrega } from '../controllers/notas.controllers';
import { authenticateToken } from '../middlewares/auth.middleware';

const router = Router();

router.use(authenticateToken);
router.get('/', getNotasEntrega as any);
router.post('/', createNotaEntrega as any);
// A-017: anulación/reversa de nota de entrada (solo ADMIN/SUPERVISOR). Idempotente.
router.post('/:id/reversar', reverseNotaEntrega as any);

export default router;