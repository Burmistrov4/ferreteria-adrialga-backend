import { Request, Response } from 'express';
import { TesoreriaService } from '../services/tesoreria.service';
import { responderErrorPrisma } from '../utils/errores';
import { IoStore } from '../utils/socket';

// FASE 2: Number('') === 0 y Number('abc') === NaN. Aceptar NaN en un calculo
// de tesoreria silencia el error y produce saldos corruptos. Se normaliza:
// valor no finito -> 0, y se rechaza la operacion si falta un dato critico.
const numSeguro = (v: unknown, defecto = 0): number => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : defecto;
  if (typeof v === 'string' && v.trim() === '') return defecto;
  const n = Number(v);
  return Number.isFinite(n) ? n : defecto;
};

export const getTesoreriaSaldo = async (_req: Request, res: Response) => {
  try {
    const data = await TesoreriaService.obtenerSaldoCaja();
    res.json(data);
  } catch (error: unknown) {
    // FASE 3: mapeo uniforme Prisma -> HTTP.
    return responderErrorPrisma(res, error, {
      recurso: 'tesoreria',
      contexto: 'obtener el saldo de',
    });
  }
};

/// Verifica si hay fondos suficientes en caja para dar vuelto.
/// Query params: montoUSD, montoVES, tasaCambio
export const verificarFondosVuelto = async (req: Request, res: Response) => {
  try {
    const montoUSD = numSeguro(req.query.montoUSD ?? req.body?.montoUSD, 0);
    const montoVES = numSeguro(req.query.montoVES ?? req.body?.montoVES, 0);
    const tasaCambio = numSeguro(req.query.tasaCambio ?? req.body?.tasaCambio, 0);

    // Sin tasa de cambio no se puede convertir VES -> USD: se rechaza con 400
    // en vez de responder "hay fondos" con una division por cero.
    if (montoVES > 0 && tasaCambio <= 0) {
      return res.status(400).json({
        success: false,
        code: 'NULO_INVALIDO',
        message: 'Se requiere tasaCambio mayor a 0 para evaluar el vuelto en VES.',
      });
    }

    const resultado = await TesoreriaService.verificarFondosVuelto(montoUSD, montoVES, tasaCambio);
    res.json(resultado);
  } catch (error: unknown) {
    return responderErrorPrisma(res, error, {
      recurso: 'tesoreria',
      contexto: 'verificar los fondos de vuelto en',
    });
  }
};

export const getPatrimonioOperativo = async (_req: Request, res: Response) => {
  try {
    const data = await TesoreriaService.calcularPatrimonioOperativo();
    res.json(data);
  } catch (error: unknown) {
    return responderErrorPrisma(res, error, {
      recurso: 'tesoreria',
      contexto: 'calcular el patrimonio operativo en',
    });
  }
};

export const getCuentasPorPagar = async (_req: Request, res: Response) => {
  try {
    const data = await TesoreriaService.listarCuentasPorPagar();
    // FASE 2: estado vacio explicito. Una lista nula rompe el ListView del
    // cliente; se garantiza siempre un arreglo.
    res.json(Array.isArray(data) ? data : []);
  } catch (error: unknown) {
    return responderErrorPrisma(res, error, {
      recurso: 'tesoreria',
      contexto: 'listar las cuentas por pagar en',
    });
  }
};

export const abonarCuentaPorPagar = async (req: Request, res: Response) => {
  try {
    const { cxpId, monto, metodoPago } = req.body ?? {};

    // FASE 2/3: validacion de entrada antes de tocar la base de datos.
    // Number('abc') -> NaN llegaba hasta Prisma y producia un 500 opaco.
    const idCxp = numSeguro(cxpId, NaN);
    const montoAbono = numSeguro(monto, NaN);
    if (!Number.isInteger(idCxp) || idCxp <= 0) {
      return res.status(400).json({
        success: false,
        code: 'NULO_INVALIDO',
        message: 'El identificador de la cuenta por pagar no es valido.',
        error: 'El identificador de la cuenta por pagar no es valido.',
      });
    }
    if (!Number.isFinite(montoAbono) || montoAbono <= 0) {
      return res.status(400).json({
        success: false,
        code: 'NULO_INVALIDO',
        message: 'El monto del abono debe ser un numero mayor a cero.',
        error: 'El monto del abono debe ser un numero mayor a cero.',
      });
    }

    const data = await TesoreriaService.abonarCuentaPorPagar(
      idCxp,
      montoAbono,
      metodoPago ?? 'Efectivo'
    );
    // La transacción actualiza CxP, movimientos de caja y saldo de la gaveta.
    // Emitir solo después de confirmar para que los otros terminales refresquen.
    IoStore.emitDbUpdate('finanzas', `Abono registrado a CxP #${idCxp}`, { cxpId: idCxp });
    IoStore.emitDbUpdate('caja', `Movimiento de caja por abono a CxP #${idCxp}`, { cxpId: idCxp });
    res.json(data);
  } catch (error: unknown) {
    // Fondo de maniobra insuficiente → 422 exponiendo el tipo para que la
    // UI ofrezca "Ingreso de Caja" o reduzca el abono.
    const mensaje = (error as any)?.message;
    if (typeof mensaje === 'string' && mensaje.startsWith('SALDO_INSUFICIENTE:')) {
      const texto = mensaje.replace('SALDO_INSUFICIENTE:', '').trim();
      return res.status(422).json({
        success: false,
        code: 'NULO_INVALIDO',
        message: texto,
        error: texto,
        tipo: 'SALDO_INSUFICIENTE',
      });
    }
    return responderErrorPrisma(res, error, {
      recurso: 'cuenta por pagar',
      contexto: 'abonar la',
    });
  }
};

