import { Router } from 'express';
import {
  getCategorias,
  createCategoria,
  updateCategoria,
  deleteCategoria,
  getSiguienteSku
} from '../controllers/categorias.controllers';
import { authenticateToken } from '../middlewares/auth.middleware';

const router = Router();

router.use(authenticateToken);
router.get('/', getCategorias);
router.get('/:id/siguiente-sku', getSiguienteSku);
router.post('/', createCategoria);
router.put('/:id', updateCategoria);
router.delete('/:id', deleteCategoria);

export default router;