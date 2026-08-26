import { Router } from 'express';
import { getNotasEntrega, createNotaEntrega } from '../controllers/notas.controllers';
import { authenticateToken } from '../middlewares/auth.middleware';

const router = Router();

router.use(authenticateToken);
router.get('/', getNotasEntrega as any);
router.post('/', createNotaEntrega as any);

export default router;