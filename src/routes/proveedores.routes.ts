import { Router } from 'express';
import { getProveedores, createProveedor, updateProveedor, deleteProveedor } from '../controllers/proveedores.controllers';
import { authenticateToken } from '../middlewares/auth.middleware';

const router = Router();

router.use(authenticateToken);
router.get('/', getProveedores);
router.post('/', createProveedor);
router.put('/:id', updateProveedor);
router.delete('/:id', deleteProveedor);

export default router;