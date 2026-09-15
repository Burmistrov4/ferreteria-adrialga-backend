import { Router } from 'express';
import {
  getProductos,
  createProducto,
  updateProducto,
  deleteProducto,
  getVariantesDeProducto,
  crearVariantesBulk,
  actualizarVariante,
} from '../controllers/productos.controllers';
import { authenticateToken } from '../middlewares/auth.middleware';

const router = Router();

router.use(authenticateToken);
router.get('/', getProductos);
router.get('/:id/variantes', getVariantesDeProducto);
router.post('/:id/variantes/bulk', crearVariantesBulk);
router.patch('/variantes/:id', actualizarVariante);
router.post('/', createProducto);
router.put('/:id', updateProducto);
router.delete('/:id', deleteProducto);

export default router;