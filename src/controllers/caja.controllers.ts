import { Request, Response } from 'express';
import { prisma } from '../config/db';
import { toD4, aDecimal } from '../utils/dinero';
import { obtenerCajaAbierta } from '../utils/caja';
import { evaluarArqueo } from '../utils/arqueo';
import { validarPinSupervisorHash } from '../utils/pin_supervisor';

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
 * Abre un nuevo turno de caja con **periodicidad forzada**:
 *  - No se permite abrir si existe un turno ABIERTA (409: ciérrelo primero).
 *  - No se permite abrir más de un turno por jornada UTC (409).
 *  - Un turno ya registrado hoy tampoco se cierra automáticamente: el arqueo
 *    es una obligación del cajero, nunca una acción silenciosa del sistema.
 * El monto inicial se registra como INGRESO manual y define el
 * Saldo_Inicial/Saldo_Actual del turno.
 */
export const abrirCaja = async (req: Request, res: Response) => {
  try {
    const montoInicialD4 = toD4(req.body.montoInicial ?? 0);
    if (montoInicialD4 <= 0n) {
      return res.status(400).json({
        error: 'El fondo base de caja debe ser mayor a $0.00 para abrir el turno',
      });
    }

    // ── Periodicidad forzada (validaciones previas a la transacción) ────────
    const activa = await obtenerCajaAbierta(prisma as any);
    if (activa) {
      return res.status(409).json({
        error: `Ya existe un turno de caja abierto (apertura ${activa.Fecha_Apertura.toISOString().slice(0, 10)}). Realice el cierre/arqueo antes de abrir uno nuevo.`,
        caja: sanitizarCaja(activa),
      });
    }
    const inicioJornada = new Date();
    inicioJornada.setUTCHours(0, 0, 0, 0);
    const turnoHoy = await prisma.caja.findFirst({
      where: { Fecha_Apertura: { gte: inicioJornada } },
      orderBy: { Fecha_Apertura: 'desc' },
    });
    if (turnoHoy) {
      return res.status(409).json({
        error: `Ya se registró una apertura de caja en la jornada de hoy (turno #${turnoHoy.Caja_ID}, estado ${turnoHoy.Estado}). Solo se permite un turno por día.`,
        caja: sanitizarCaja(turnoHoy),
      });
    }

    const caja = await prisma.$transaction(async (tx) => {
      // Nuevo turno.
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
      : Number(aDecimal(toD4(req.body.montoContado)));

    // ── Regla de negocio: el conteo debe cuadrar dentro de ±1 USD ────────────
    // Lógica pura extraída a src/utils/arqueo.ts (testeable sin BD).
    const { cuadra, diferencia, estado } = evaluarArqueo(saldoActual, montoContado);
    if (!cuadra) {
      return res.status(422).json({
        error: `El arqueo no cuadra: el conteo ($${(saldoActual - diferencia).toFixed(2)}) difiere del saldo en caja ($${saldoActual.toFixed(2)}) en más de $1.00. Revise antes de cerrar.`,
        saldoActual,
        montoContado,
        diferencia,
        estado,
      });
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

/**
 * POST /api/caja/ingreso
 * body: { monto, metodoPago?, observacion?, pinSupervisor? }
 *
 * Fondo de maniobra: inyecta dinero a la caja del turno activo (para dar
 * vuelto o cubrir compras de contado). Exige que el usuario autenticado sea
 * SUPERVISOR/ADMIN o que envíe el PIN de supervisor (autorización en caliente,
 * bcrypt). Registra INGRESO y suma al Saldo_Actual dentro de la transacción.
 */
export const ingresarFondoCaja = async (req: Request, res: Response) => {
  try {
    const { monto, metodoPago, observacion } = req.body;
    const pin = (req.body?.pinSupervisor ?? '').toString().trim();

    const montoD4 = toD4(monto);
    if (montoD4 <= 0n) {
      return res.status(400).json({ error: 'El monto del ingreso debe ser mayor a $0.00' });
    }

    // ── Autorización: el rol del token o el PIN de supervisor ─────────────
    const rol = ((req as any).user?.rol ?? '').toString().toUpperCase();
    const esSupervisor = rol === 'SUPERVISOR' || rol === 'ADMIN';
    if (!esSupervisor) {
      const autorizado = await validarPinSupervisorHash(prisma, pin);
      if (!autorizado) {
        return res.status(401).json({ error: 'PIN de Supervisor inválido', tipo: 'PIN_INVALIDO' });
      }
    }

    const caja = await obtenerCajaAbierta(prisma as any);
    if (!caja) {
      return res.status(409).json({ error: 'No hay una caja abierta', tipo: 'CAJA_CERRADA' });
    }

    const resultado = await prisma.$transaction(async (tx) => {
      await tx.movimientos_caja.create({
        data: {
          Caja_ID: caja.Caja_ID,
          Tipo: 'INGRESO',
          Concepto: observacion
            ? `Ingreso de caja (fondo de maniobra): ${observacion}`
            : 'Ingreso de caja (fondo de maniobra)',
          Metodo_Pago: metodoPago ?? 'Efectivo',
          Monto_USD: aDecimal(montoD4),
          Origen_Tipo: 'manual',
          Fecha: new Date()
        }
      });
      return tx.caja.update({
        where: { Caja_ID: caja.Caja_ID },
        data: { Saldo_Actual: { increment: aDecimal(montoD4) } }
      });
    });

    return res.status(201).json({
      message: 'Ingreso de caja registrado correctamente',
      caja: sanitizarCaja(resultado)
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

/**
 * GET /api/caja/historico?anio=&mes=
 *
 * Reporte de arqueos del mes: cada turno (abierto o cerrado) con su
 * saldo inicial, ingresos, egresos operativos, saldo esperado, saldo
 * entregado al cierre y la diferencia (faltante/sobrante).
 * Los EGRESOS con concepto que inicia con "Cierre de caja" se interpretan
 * como entrega del efectivo al cierre (no como egresos operativos).
 */
export const getHistoricoArqueos = async (req: Request, res: Response) => {
  try {
    const ahora = new Date();
    let anio = Number(req.query.anio ?? ahora.getUTCFullYear());
    let mes = Number(req.query.mes ?? ahora.getUTCMonth() + 1);
    if (!Number.isInteger(anio) || anio < 2000 || anio > 2100) anio = ahora.getUTCFullYear();
    if (!Number.isInteger(mes) || mes < 1 || mes > 12) mes = ahora.getUTCMonth() + 1;

    const desde = new Date(Date.UTC(anio, mes - 1, 1));
    const hasta = new Date(Date.UTC(anio, mes, 1));

    const turnos = await prisma.caja.findMany({
      where: { Fecha_Apertura: { gte: desde, lt: hasta } },
      include: { movimientos: true },
      orderBy: { Fecha_Apertura: 'desc' },
    });

    const filas = turnos.map((t) => {
      let ingresos = 0;
      let egresosOperativos = 0;
      let saldoEntregado = 0;
      for (const m of t.movimientos) {
        const monto = Number(m.Monto_USD);
        if (m.Tipo === 'INGRESO') {
          ingresos += monto;
        } else if (m.Tipo === 'EGRESO') {
          if ((m.Concepto ?? '').startsWith('Cierre de caja')) saldoEntregado += monto;
          else egresosOperativos += monto;
        }
      }
      const saldoInicial = Number(t.Saldo_Inicial);
      const saldoEsperado = saldoInicial + ingresos - egresosOperativos;
      return {
        turnoId: t.Caja_ID,
        estado: t.Estado,
        apertura: t.Fecha_Apertura.toISOString(),
        cierre: t.Fecha_Cierre ? t.Fecha_Cierre.toISOString() : null,
        saldoInicial: Number(saldoInicial.toFixed(4)),
        ingresos: Number(ingresos.toFixed(4)),
        egresosOperativos: Number(egresosOperativos.toFixed(4)),
        saldoEsperado: Number(saldoEsperado.toFixed(4)),
        saldoEntregado: Number(saldoEntregado.toFixed(4)),
        // >0 → faltante (entregó menos); <0 → sobrante (entregó de más)
        diferencia: Number((saldoEsperado - saldoEntregado).toFixed(4)),
        // Estado explícito para la UI (solo aplica a turnos cerrados):
        // MATCH / SURPLUS / DEFICIT con tolerancia de $0.01 para el reporte.
        estadoArqueo: t.Estado === 'CERRADA'
          ? evaluarArqueo(saldoEsperado, saldoEntregado, 0.01).estado
          : null,
        movimientos: t.movimientos.length,
      };
    });

    res.json({ anio, mes, total: filas.length, filas });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};