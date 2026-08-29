import { Router } from 'express';
import {
  getCategorias,
  createCategoria,
  updateCategoria,
  deleteCategoria
} from '../controllers/categorias.controllers';
import { authenticateToken } from '../middlewares/auth.middleware';

const router = Router();

router.use(authenticateToken);
router.get('/', getCategorias);
router.post('/', createCategoria);
router.put('/:id', updateCategoria);
router.delete('/:id', deleteCategoria);

export default router;