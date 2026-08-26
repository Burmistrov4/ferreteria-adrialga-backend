import { Router } from 'express';
import { getProveedores, createProveedor } from '../controllers/proveedores.controllers';
import { authenticateToken } from '../middlewares/auth.middleware';

const router = Router();

router.use(authenticateToken);
router.get('/', getProveedores);
router.post('/', createProveedor);

export default router;