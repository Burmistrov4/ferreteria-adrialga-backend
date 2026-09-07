import { Request, Response } from 'express';
import { prisma } from '../config/db';
import { toD4, aDecimal } from '../utils/dinero';
import { obtenerCajaAbierta } from '../utils/caja';

// Prisma devuelve DECIMAL como objetos Decimal; se normalizan a Number.
const decToNumber = (v: any): number | null =>
  v === null || v === undefined ? null : Number(v.toString());

const sanitizarCaja = (caja: any) =>
  caja && {
    ...caja,
    Saldo_Inicial: decToNumber(caja.Saldo_Inicial),
    Saldo_Actual: decToNumber(caja.Saldo_Actual),
  };

/**
 * GET /api/caja/estado
 *
 * Estado actual de la caja/turno: si hay una caja abierta (Activa=true) con su
 * saldo, y el resumen de ingresos/egresos del turno. Sin error si no hay caja.
 * El cliente usa `cajaActiva: boolean` para mostrar "Abrir Caja" o "Cerrar Caja".
 */
export const getEstadoCaja = async (_req: Request, res: Response) => {
  try {
    const cajaAbierta = await obtenerCajaAbierta(prisma as any);

    let ingresosTurno = 0;
    let egresosTurno = 0;
    let movimientos: any[] = [];
    if (cajaAbierta) {
      const agrupado = await prisma.movimientos_caja.groupBy({
        by: ['Tipo'],
        where: { Caja_ID: cajaAbierta.Caja_ID },
        _sum: { Monto_USD: true }
      });
      for (const g of agrupado) {
        const monto = Number(g._sum?.Monto_USD ?? 0);
        if (g.Tipo === 'INGRESO') ingresosTurno = monto;
        else if (g.Tipo === 'EGRESO') egresosTurno = monto;
      }
      movimientos = (
        await prisma.movimientos_caja.findMany({
          where: { Caja_ID: cajaAbierta.Caja_ID },
          orderBy: { Movimiento_ID: 'desc' },
          take: 50
        })
      ).map((m) => ({
        ...m,
        Monto_USD: Number(m.Monto_USD),
        Tasa_Cambio: m.Tasa_Cambio === null ? null : Number(m.Tasa_Cambio)
      }));
    }

    res.json({
      cajaActiva: Boolean(cajaAbierta),
      caja: cajaAbierta ? sanitizarCaja(cajaAbierta) : null,
      movimientos,
      resumenTurno: {
        ingresosUSDTurno: ingresosTurno,
        egresosUSDTurno: egresosTurno,
        ingresoNetoTurno: Number((ingresosTurno - egresosTurno).toFixed(4))
      }
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

/**
 * POST /api/caja/abrir
 * body: { montoInicial?: number, observacion?: string }
 *
 * Abre un nuevo turno de caja. Si existe un turno activo lo cierra primero
 * (arqueo automático de seguridad). El monto inicial se registra como INGRESO
 * manual y define el Saldo_Inicial/Saldo_Actual del turno.
 */
export const abrirCaja = async (req: Request, res: Response) => {
  try {
    const montoInicialD4 = toD4(req.body.montoInicial ?? 0);
    if (montoInicialD4 < 0n) {
      return res.status(400).json({ error: 'El monto inicial no puede ser negativo' });
    }

    const caja = await prisma.$transaction(async (tx) => {
      // 1. Cerrar cualquier turno activo pendiente (evita dobles turnos).
      const activa = await obtenerCajaAbierta(tx as any);
      if (activa) {
        await tx.caja.update({
          where: { Caja_ID: activa.Caja_ID },
          data: {
            Activa: false,
            Estado: 'CERRADA',
            Fecha_Cierre: new Date()
          }
        });
      }

      // 2. Nuevo turno.
      const nueva = await tx.caja.create({
        data: {
          Nombre: 'Caja Principal',
          Saldo_Inicial: aDecimal(montoInicialD4),
          Saldo_Actual: aDecimal(montoInicialD4),
          Activa: true,
          Estado: 'ABIERTA',
          Fecha_Apertura: new Date()
        }
      });

      // 3. Registrar el monto de arranque como primer movimiento.
      if (montoInicialD4 > 0n) {
        await tx.movimientos_caja.create({
          data: {
            Caja_ID: nueva.Caja_ID,
            Tipo: 'INGRESO',
            Concepto: req.body.observacion
              ? `Apertura de caja: ${req.body.observacion}`
              : 'Apertura de caja',
            Metodo_Pago: 'Efectivo',
            Monto_USD: aDecimal(montoInicialD4),
            Origen_Tipo: 'manual',
            Fecha: new Date()
          }
        });
      }
      return nueva;
    });

    res.status(201).json({ message: 'Caja abierta correctamente', caja: sanitizarCaja(caja) });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};
/**
 * POST /api/caja/cerrar
 * body: { montoContado?: number, observacion?: string }
 *
 * Cierra el turno activo (arqueo). Si se envía montoContado, se valida contra
 * el Saldo_Actual del turno con una tolerancia de ±1 USD (diferencias de
 * redondeo o monedas); un faltante/sobrante mayor se rechaza para que el cajero
 * concilie antes de cerrar. Al cerrar se registra un EGRESO por el saldo
 * entregado y se marca la caja como CERRADA.
 */
export const cerrarCaja = async (req: Request, res: Response) => {
  try {
    const caja = await obtenerCajaAbierta(prisma as any);
    if (!caja) {
      return res.status(409).json({ error: 'No hay una caja abierta que cerrar' });
    }

    const saldoActual = Number(caja.Saldo_Actual);
    const montoContado = req.body.montoContado == null
      ? null
      : toD4(req.body.montoContado);
    const montoContadoNum = montoContado === null ? null : Number(aDecimal(montoContado));

    if (montoContadoNum !== null) {
      const diferencia = Math.abs(montoContadoNum - saldoActual);
      const TOLERANCIA = 1.0; // ±1 USD por redondeo/moneda menor
      if (diferencia > TOLERANCIA) {
        return res.status(422).json({
          error: `El arqueo no cuadra: el conteo ($${montoContadoNum.toFixed(2)}) difiere del saldo en caja ($${saldoActual.toFixed(2)}) en más de $1.00. Revise antes de cerrar.`,
          saldoActual,
          montoContado: montoContadoNum
        });
      }
    }

    const saldoD4 = toD4(saldoActual);
    const cerrada = await prisma.$transaction(async (tx) => {
      if (saldoD4 > 0n) {
        await tx.movimientos_caja.create({
          data: {
            Caja_ID: caja.Caja_ID,
            Tipo: 'EGRESO',
            Concepto: req.body.observacion
              ? `Cierre de caja (arqueo): ${req.body.observacion}`
              : 'Cierre de caja (arqueo)',
            Metodo_Pago: 'Efectivo',
            Monto_USD: aDecimal(saldoD4),
            Origen_Tipo: 'manual',
            Fecha: new Date()
          }
        });
      }
      return tx.caja.update({
        where: { Caja_ID: caja.Caja_ID },
        data: {
          Activa: false,
          Estado: 'CERRADA',
          Fecha_Cierre: new Date(),
          Saldo_Actual: aDecimal(0n)
        }
      });
    });

    res.json({
      message: 'Caja cerrada correctamente (arqueo registrado)',
      caja: sanitizarCaja({ ...cerrada, Saldo_Actual: 0 }),
      saldoEntregado: Number(saldoActual.toFixed(4))
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};