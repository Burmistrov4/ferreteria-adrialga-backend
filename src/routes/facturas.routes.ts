import { Router } from 'express';
import { getFacturas, getFacturaById, createFactura } from '../controllers/facturas.controllers';
import { authenticateToken } from '../middlewares/auth.middleware';

const router = Router();

router.use(authenticateToken);
router.get('/', getFacturas as any);
router.get('/:id', getFacturaById as any);
router.post('/', createFactura as any);

export default router;