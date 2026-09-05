import { Router } from 'express';
import {
  getTesoreriaSaldo,
  getPatrimonioOperativo,
  getCuentasPorPagar,
  abonarCuentaPorPagar,
} from '../controllers/tesoreria.controllers';

const router = Router();

router.get('/saldo', getTesoreriaSaldo);
router.get('/patrimonio', getPatrimonioOperativo);
router.get('/cuentas-pagar', getCuentasPorPagar);
router.post('/cuentas-pagar/abonar', abonarCuentaPorPagar);

export default router;

