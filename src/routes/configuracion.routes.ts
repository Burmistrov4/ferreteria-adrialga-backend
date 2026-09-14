import { Router } from 'express';
import { getConfiguracion, updateConfiguracion } from '../controllers/configuracion.controllers';
import { authenticateToken } from '../middlewares/auth.middleware';

const router = Router();

router.use(authenticateToken);
router.get('/', getConfiguracion);
router.put('/', updateConfiguracion);

export default router;
