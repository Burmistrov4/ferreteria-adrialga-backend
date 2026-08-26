import { Router } from 'express';
import { getCategorias, createCategoria } from '../controllers/categorias.controllers';
import { authenticateToken } from '../middlewares/auth.middleware';

const router = Router();

router.use(authenticateToken);
router.get('/', getCategorias);
router.post('/', createCategoria);

export default router;