import { Router, raw } from 'express';
import {
  getProductos,
  getProductoById,
  createProducto,
  updateProducto,
  deleteProducto,
  getVariantesDeProducto,
  crearVariantesBulk,
  actualizarVariante,
  eliminarVariante,
  subirImagenProducto,
} from '../controllers/productos.controllers';
import { authenticateToken } from '../middlewares/auth.middleware';

const router = Router();

router.use(authenticateToken);
router.get('/', getProductos);
router.get('/:id', getProductoById);
router.get('/:id/variantes', getVariantesDeProducto);
router.post('/:id/variantes/bulk', crearVariantesBulk);
router.patch('/variantes/:id', actualizarVariante);
router.delete('/variantes/:id', eliminarVariante);
// Subida de imagen: cuerpo binario en crudo (image/*), máximo 8 MB.
router.post(
  '/imagen',
  raw({
    type: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    limit: '8mb',
  }),
  subirImagenProducto,
);
router.post('/', createProducto);
router.put('/:id', updateProducto);
router.delete('/:id', deleteProducto);

export default router;