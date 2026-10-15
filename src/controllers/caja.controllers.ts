import { Request, Response } from 'express';
import { AuthRequest } from '../middlewares/auth.middleware';
import { prisma } from '../config/db';
import { toD4, aDecimal, addD4, subD4 } from '../utils/dinero';
import {
  obtenerCajaAbierta,
  esEfectivo,
  inicioJornadaActual,
  bloquearCajasActivas,
  withTxCaja,
  CajaYaAbiertaError,
  CajaCerradaError,
} from '../utils/caja';
import { evaluarArqueo } from '../utils/arqueo';
import { validarPinSupervisorHash } from '../utils/pin_supervisor';
import { responderErrorPrisma } from '../utils/errores';
import { IoStore } from '../utils/socket';

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
 * Traduce errores semánticos de caja (con `status` 4xx propio) a su respuesta
 * HTTP exacta y delega el resto al mapeador Prisma uniforme. Así un 409/422
 * nunca degrada a 500 opaco.
 */
function responderErrorCaja(res: Response, error: unknown, contexto: string) {
  const err = error as any;
  if (typeof err?.status === 'number' && err.status >= 400 && err.status < 500) {
    return res.status(err.status).json({
      success: false,
      error: err.message,
      ...(err.payload ?? {}),
    });
  }
  return responderErrorPrisma(res, error, { recurso: 'caja', contexto });
}

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
        where: {
          Caja_ID: cajaAbierta.Caja_ID,
          // Mismo criterio que el histórico: el fondo de apertura ya está
          // representado en Saldo_Inicial, contarlo como ingreso del turno
          // infla `ingresoNetoTurno` con el importe del fondo.
          NOT: { Concepto: { startsWith: 'Apertura de caja' } },
          // Canal: SOLO el efectivo físico altera la gaveta (Saldo_Actual).
          // Los cobros digitales (Pago Móvil, Punto de Venta, Zelle) se
          // auditan en movimientos_caja pero van al banco; incluirlos en el
          // resumen del turno lo desalineaba con el arqueo y con el saldo
          // físico. La collation de MySQL es case-insensitive, pero se listan
          // las tres variantes para blindar contra cambios de collation.
          OR: [
            { Metodo_Pago: { contains: 'Efectivo' } },
            { Metodo_Pago: { contains: 'efectivo' } },
            { Metodo_Pago: { contains: 'EFECTIVO' } },
          ],
        },
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
  } catch (error) {
    return responderErrorPrisma(res, error, {
      recurso: 'caja',
      contexto: 'obtener el estado de la',
    });
  }
};

/**
 * POST /api/caja/abrir
 * body: { montoInicial?: number, observacion?: string }
 *
 * Abre un nuevo turno de caja:
 *  - No se permite abrir si existe un turno ABIERTO (409: ciérrelo primero).
 *  - Por defecto se permiten VARIOS turnos por jornada (turnos mañana/tarde);
 *    con CAJA_UN_TURNO_POR_DIA=true se limita a uno por día (409). La jornada
 *    se mide en el día LOCAL de Venezuela, no en UTC.
 *  - Un turno no se cierra automáticamente: el arqueo es obligación del cajero.
 * El monto inicial se registra como INGRESO manual y define el
 * Saldo_Inicial/Saldo_Actual del turno.
 */
export const abrirCaja = async (req: AuthRequest, res: Response) => {
  try {
    const montoInicialD4 = toD4(req.body.montoInicial ?? 0);
    if (montoInicialD4 <= 0n) {
      return res.status(400).json({
        error: 'El fondo base de caja debe ser mayor a $0.00 para abrir el turno',
      });
    }

    const unTurnoPorDia = (process.env.CAJA_UN_TURNO_POR_DIA ?? 'false') === 'true';

    // ── TODA la validación ocurre DENTRO de la transacción, con locking ────
    // read FOR UPDATE sobre el índice Activa (A-014). Una comprobación fuera
    // de la transacción permitía que dos aperturas simultáneas pasaran el
    // gate antes de que cualquiera creara su fila (doble turno abierto).
    const caja = await withTxCaja(prisma, async (tx) => {
      // 1) Bloquea el índice de cajas activas: el primer locking read toma el
      //    gap lock (REPEATABLE READ) y el segundo espera al commit; al
      //    re-leer, observa la fila recién creada y falla con 409.
      const activa = (await bloquearCajasActivas(tx))[0];
      if (activa) {
        throw new CajaYaAbiertaError(
          `Ya existe un turno de caja abierto (apertura ${activa.Fecha_Apertura.toISOString().slice(0, 10)}). Realice el cierre/arqueo antes de abrir uno nuevo.`,
          { caja: sanitizarCaja(activa) }
        );
      }
      // 2) Límite de turnos por jornada. POR DEFECTO se permite MÁS DE UNO
      //    (turnos mañana/tarde), que es lo que el negocio necesita. Para
      //    restaurar la regla estricta "un solo turno por día", define
      //    CAJA_UN_TURNO_POR_DIA=true en el .env. La jornada se mide en día
      //    LOCAL de Venezuela (no UTC) para corte a medianoche real.
      if (unTurnoPorDia) {
        const turnoHoy = await tx.caja.findFirst({
          where: { Fecha_Apertura: { gte: inicioJornadaActual() } },
          orderBy: { Fecha_Apertura: 'desc' },
        });
        if (turnoHoy) {
          throw new CajaYaAbiertaError(
            `Ya se registró una apertura de caja en la jornada de hoy (turno #${turnoHoy.Caja_ID}, estado ${turnoHoy.Estado}). Solo se permite un turno por día.`,
            { caja: sanitizarCaja(turnoHoy) }
          );
        }
      }
      // Nuevo turno.
      const nueva = await tx.caja.create({
        data: {
          Nombre: 'Caja Principal',
          Saldo_Inicial: aDecimal(montoInicialD4),
          Saldo_Actual: aDecimal(montoInicialD4),
          Activa: true,
          Estado: 'ABIERTA',
          Fecha_Apertura: new Date(),
          // Trazabilidad: quién abrió el turno (del JWT).
          Usuario_ID: req.user?.usuarioId ?? null
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
            Usuario_ID: req.user?.usuarioId ?? null,
            Fecha: new Date()
          }
        });
      }
      return nueva;
    });

    // Broadcast LAN: otras cajas/dispositivos refrescan el estado del turno.
    IoStore.emitDbUpdate('caja', `Caja abierta (turno #${caja.Caja_ID})`, {
      cajaId: caja.Caja_ID,
    });
    res.status(201).json({ message: 'Caja abierta correctamente', caja: sanitizarCaja(caja) });
  } catch (error) {
    return responderErrorCaja(res, error, 'abrir la');
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
export const cerrarCaja = async (req: AuthRequest, res: Response) => {
  try {
    const montoContado = req.body.montoContado == null
      ? null
      : Number(aDecimal(toD4(req.body.montoContado)));

    // ── TODA la lógica bajo bloqueo de la fila activa (A-015) ─────────────
    // El locking read FOR UPDATE serializa cierre vs cierre y cierre vs
    // venta (que también bloquea la fila vía exigirCajaAbierta):
    //  - Dos cierres simultáneos: el segundo espera el commit del primero,
    //    re-lee Activa=false → 409, y NO registra un segundo EGRESO (un
    //    reintento tras timeout tampoco duplica la entrega de efectivo).
    //  - La evaluación de arqueo usa el Saldo_Actual leído BAJO BLOQUEO, no
    //    una lectura previa que pudo quedar obsoleta por una venta en curso.
    const { cerrada, saldoEntregado } = await withTxCaja(prisma, async (tx) => {
      const caja = (await bloquearCajasActivas(tx))[0];
      if (!caja) {
        throw new CajaCerradaError('No hay una caja abierta que cerrar');
      }

      const saldoActual = Number(caja.Saldo_Actual);

      // Regla de negocio: el conteo debe cuadrar dentro de ±1 USD.
      // Lógica pura en src/utils/arqueo.ts (testeable sin BD).
      const { cuadra, diferencia, estado } = evaluarArqueo(saldoActual, montoContado);
      if (!cuadra) {
        const err: any = new Error(
          `El arqueo no cuadra: el conteo ($${(saldoActual - diferencia).toFixed(2)}) difiere del saldo en caja ($${saldoActual.toFixed(2)}) en más de $1.00. Revise antes de cerrar.`
        );
        err.status = 422;
        err.payload = { saldoActual, montoContado, diferencia, estado };
        throw err;
      }

      const saldoD4 = toD4(saldoActual);
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
            Usuario_ID: req.user?.usuarioId ?? null,
            Fecha: new Date()
          }
        });
      }
      const cerrada = await tx.caja.update({
        where: { Caja_ID: caja.Caja_ID },
        data: {
          Activa: false,
          Estado: 'CERRADA',
          Fecha_Cierre: new Date(),
          Saldo_Actual: aDecimal(0n)
        }
      });
      return { cerrada, saldoEntregado: Number(saldoActual.toFixed(4)) };
    });

    IoStore.emitDbUpdate('caja', 'Caja cerrada (arqueo registrado)', {
      cajaId: cerrada.Caja_ID,
    });
    res.json({
      message: 'Caja cerrada correctamente (arqueo registrado)',
      caja: sanitizarCaja({ ...cerrada, Saldo_Actual: 0 }),
      saldoEntregado
    });
  } catch (error) {
    return responderErrorCaja(res, error, 'cerrar la');
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
export const ingresarFondoCaja = async (req: AuthRequest, res: Response) => {
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

    // El gate de "turno abierto" va DENTRO de la transacción con bloqueo:
    // si un cierre está en curso, este ingreso espera el fin del cierre y
    // luego falla con 409 en vez de inyectar dinero en un turno ya cerrado.
    const resultado = await withTxCaja(prisma, async (tx) => {
      const caja = (await bloquearCajasActivas(tx))[0];
      if (!caja) {
        throw new CajaCerradaError('No hay una caja abierta');
      }
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
          Usuario_ID: req.user?.usuarioId ?? null,
          Fecha: new Date()
        }
      });
      return tx.caja.update({
        where: { Caja_ID: caja.Caja_ID },
        data: { Saldo_Actual: { increment: aDecimal(montoD4) } }
      });
    });

    IoStore.emitDbUpdate('caja', 'Ingreso de caja (fondo de maniobra)', {
      cajaId: resultado.Caja_ID,
    });
      return res.status(201).json({
      message: 'Ingreso de caja registrado correctamente',
      caja: sanitizarCaja(resultado)
    });
  } catch (error: unknown) {
    // FASE 3: mapeo uniforme de errores (409 de negocio o Prisma -> HTTP).
    return responderErrorCaja(res, error, 'registrar el ingreso en la');
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
      // FASE 2: las sumas se acumulan en enteros escalados a 4 decimales
      // (BigInt), NO en `number`. Sumar cientos de montos en coma flotante
      // arrastra error de redondeo (0.1 + 0.2 !== 0.3) que en un arqueo
      // aparece como faltante/sobrante fantasma de centavos.
      let ingresosD4 = 0n;
      let egresosOperativosD4 = 0n;
      let saldoEntregadoD4 = 0n;
      for (const m of t.movimientos) {
        const montoD4 = toD4(m.Monto_USD);
        const concepto = (m.Concepto ?? '').trim();
        // ── Canal de pago (BUG CORREGIDO: "falta dinero" fantasma) ──────────
        // Solo el EFECTIVO físico (Efectivo / Efectivo USD / Efectivo VES)
        // mueve Saldo_Actual (ver `esEfectivo` y `createFactura`). Los cobros
        // digitales (Pago Móvil, Punto de Venta, Zelle) se registran en
        // movimientos_caja para auditoría, pero van al banco: sumarlos aquí
        // inflaba `saldoEsperado` y TODO turno con pagos digitales reportaba
        // un faltante fantasma igual al monto digital (y como los pagos en Bs
        // guardan su importe en `Monto_USD`, el faltante llegaba a cifras
        // enormes). El arqueo debe comparar peras con peras: gaveta física.
        if (m.Tipo === 'INGRESO') {
          // `abrirCaja` guarda Saldo_Inicial = montoInicial Y además registra
          // un INGRESO "Apertura de caja" por el mismo importe, pero NO
          // incrementa Saldo_Actual con él. Sumarlo aquí duplicaba el fondo:
          //   saldoEsperado = Saldo_Inicial + (apertura + ventas) = 2*fondo + ventas
          // y TODO turno cerrado reportaba un DEFICIT falso igual al fondo.
          if (concepto.startsWith('Apertura de caja')) continue;
          if (!esEfectivo(m.Metodo_Pago)) continue;
          ingresosD4 = addD4(ingresosD4, montoD4);
        } else if (m.Tipo === 'EGRESO') {
          // Un egreso con concepto "Cierre de caja..." NO es gasto operativo:
          // es el efectivo entregado al cerrar el turno (siempre en efectivo).
          if ((m.Concepto ?? '').startsWith('Cierre de caja')) {
            saldoEntregadoD4 = addD4(saldoEntregadoD4, montoD4);
          } else if (esEfectivo(m.Metodo_Pago)) {
            // Egresos digitales (reembolsos por banco) tampoco salen del cajón.
            egresosOperativosD4 = addD4(egresosOperativosD4, montoD4);
          }
        }
      }
      const saldoInicialD4 = toD4(t.Saldo_Inicial);
      const saldoEsperadoD4 = subD4(addD4(saldoInicialD4, ingresosD4), egresosOperativosD4);

      // La conversion a Number ocurre SOLO en la frontera de salida.
      const saldoInicial = Number(aDecimal(saldoInicialD4));
      const ingresos = Number(aDecimal(ingresosD4));
      const egresosOperativos = Number(aDecimal(egresosOperativosD4));
      const saldoEsperado = Number(aDecimal(saldoEsperadoD4));
      const saldoEntregado = Number(aDecimal(saldoEntregadoD4));
      const diferencia = Number(aDecimal(subD4(saldoEsperadoD4, saldoEntregadoD4)));

      // Fechas: Prisma puede devolver null; se normaliza a ISO o null en vez
      // de invocar .toISOString() a ciegas (TypeError en runtime).
      const iso = (d: unknown): string | null => {
        if (!d) return null;
        const fecha = d instanceof Date ? d : new Date(String(d));
        return Number.isNaN(fecha.getTime()) ? null : fecha.toISOString();
      };
      return {
        turnoId: t.Caja_ID,
        estado: t.Estado,
        apertura: iso(t.Fecha_Apertura),
        cierre: iso(t.Fecha_Cierre),
        saldoInicial,
        ingresos,
        egresosOperativos,
        saldoEsperado,
        saldoEntregado,
        // >0 → faltante (entregó menos); <0 → sobrante (entregó de más)
        diferencia,
        // Estado explícito para la UI (solo aplica a turnos cerrados):
        // MATCH / SURPLUS / DEFICIT con tolerancia de $0.01 para el reporte.
        estadoArqueo: t.Estado === 'CERRADA'
          ? evaluarArqueo(saldoEsperado, saldoEntregado, 0.01).estado
          : null,
        movimientos: t.movimientos.length,
      };
    });

    res.json({ anio, mes, total: filas.length, filas });
  } catch (error: unknown) {
    // FASE 3: mapeo uniforme Prisma -> HTTP (nunca un 500 opaco al cliente).
    return responderErrorPrisma(res, error, {
      recurso: 'caja',
      contexto: 'obtener el historico de arqueos de la',
    });
  }
};