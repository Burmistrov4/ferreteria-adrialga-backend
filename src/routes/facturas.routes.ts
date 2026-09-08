import { Router } from 'express';
import { getFacturas, getFacturaById, createFactura, reversarVenta } from '../controllers/facturas.controllers';
import { authenticateToken } from '../middlewares/auth.middleware';

const router = Router();

router.use(authenticateToken);
router.get('/', getFacturas as any);
router.get('/:id', getFacturaById as any);
router.post('/', createFactura as any);
router.post('/:id/reversar', reversarVenta as any);

export default router;