import { Router } from 'express';
import { login, validarPinSupervisor } from '../controllers/auth.controllers';
import { authenticateToken } from '../middlewares/auth.middleware';
import { pinLimiter } from '../middlewares/limiters';

const router = Router();

router.post('/login', login);
// pinLimiter va DESPUÉS de authenticateToken (necesita req.user para limitar
// por usuario además de por IP) y antes del controlador (frena la fuerza bruta
// del PIN de 4-6 dígitos, que permitiría escalar a SUPERVISOR).
router.post('/validar-pin-supervisor', authenticateToken, pinLimiter, validarPinSupervisor as any);

export default router;