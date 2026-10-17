import { Router } from 'express';
import { getFacturas, getFacturaById, createFactura, reversarVenta } from '../controllers/facturas.controllers';
import { authenticateToken } from '../middlewares/auth.middleware';
import { pinLimiter } from '../middlewares/limiters';

const router = Router();

router.use(authenticateToken);
router.get('/', getFacturas as any);
router.get('/:id', getFacturaById as any);
router.post('/', createFactura as any);
// La reversa exige PIN de supervisor: se frena la fuerza bruta de ese PIN.
router.post('/:id/reversar', pinLimiter, reversarVenta as any);

export default router;