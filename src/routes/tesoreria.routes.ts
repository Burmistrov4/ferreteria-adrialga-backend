import { Router } from 'express';
import {
  getTesoreriaSaldo,
  getPatrimonioOperativo,
  getCuentasPorPagar,
  abonarCuentaPorPagar,
  verificarFondosVuelto,
} from '../controllers/tesoreria.controllers';
import { authenticateToken } from '../middlewares/auth.middleware';

const router = Router();

// HALLAZGO DE AUDITORÍA (2026-10-14): este router quedó sin autenticación —
// GET /api/tesoreria/saldo|patrimonio|cuentas-pagar devolvían 200 sin token y
// POST /cuentas-pagar/abonar (escritura) era invocable por cualquier equipo de
// la LAN. Se exige JWT en TODO el router, igual que el resto de módulos.
router.use(authenticateToken);

router.get('/saldo', getTesoreriaSaldo);
router.get('/verificar-fondos', verificarFondosVuelto);
router.get('/patrimonio', getPatrimonioOperativo);
router.get('/cuentas-pagar', getCuentasPorPagar);
router.post('/cuentas-pagar/abonar', abonarCuentaPorPagar);

export default router;

