import { Router } from 'express';
import { getClientes, createCliente } from '../controllers/clientes.controllers';
import { authenticateToken } from '../middlewares/auth.middleware';

const router = Router();

router.use(authenticateToken);
router.get('/', getClientes);
router.post('/', createCliente);

export default router;