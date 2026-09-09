import { Router } from 'express';
import { login, validarPinSupervisor } from '../controllers/auth.controllers';
import { authenticateToken } from '../middlewares/auth.middleware';

const router = Router();

router.post('/login', login);
router.post('/validar-pin-supervisor', authenticateToken, validarPinSupervisor as any);

export default router;