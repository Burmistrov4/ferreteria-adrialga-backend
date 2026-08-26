import { Router } from 'express';
import { getProductos, createProducto } from '../controllers/productos.controllers';
import { authenticateToken } from '../middlewares/auth.middleware';

const router = Router();

router.use(authenticateToken);
router.get('/', getProductos);
router.post('/', createProducto);

export default router;