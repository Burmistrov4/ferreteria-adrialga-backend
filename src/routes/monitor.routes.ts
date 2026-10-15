import { Router } from 'express';
import { getEsquemaMonitor } from '../controllers/monitor.controllers';
import { authenticateToken } from '../middlewares/auth.middleware';

const router = Router();

router.use(authenticateToken);
router.get('/esquema', getEsquemaMonitor);

export default router;
