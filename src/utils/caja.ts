import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Error semántico para operaciones que requieren una caja abierta.
 * Se serializa como HTTP 409 para que el cliente muestre el mensaje
 * de forma amigable y bloquee la operación.
 */
export class CajaCerradaError extends Error {
  public status = 409;
  constructor(
    message =
      'Debe abrir la caja antes de realizar esta operación (arqueo pendiente).'
  ) {
    super(message);
    this.name = 'CajaCerradaError';
  }
}

/**
 * Error semántico: existe un turno de un día ANTERIOR que nunca fue cerrado
 * ni conciliado (sin Fecha_Cierre). El arqueo Z de esa jornada es obligatorio
 * antes de facturar de nuevo (mandato FRENTE 2: control de cierres).
 */
export class ArqueoPendienteError extends Error {
  public status = 409;
  constructor(turnoId: number, fechaApertura: Date) {
    super(
      `Arqueo pendiente: el turno #${turnoId} abierto el ` +
      `${fechaApertura.toISOString().slice(0, 10)} no tiene cierre registrado. ` +
      `Realice el arqueo Z de esa jornada antes de emitir nuevas facturas.`
    );
    this.name = 'ArqueoPendienteError';
  }
}

/**
 * Fecha (jornada) actual truncada a medianoche UTC.
 */
function inicioJornadaActual(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Asegura que exista una Caja Principal activa. Si ninguna caja está activa,
 * se crea con saldo 0. Reutilizable dentro de una transacción (tx) o con el
 * cliente global (prisma).
 *
 * @param tx cliente Prisma (transacción o global)
 * @returns la caja principal activa
 */
export async function asegurarCajaPrincipal(
  tx: Prisma.TransactionClient | PrismaClient
) {
  const existente = await tx.caja.findFirst({ where: { Activa: true } });
  if (existente) return existente;

  return tx.caja.create({
    data: {
      Nombre: 'Caja Principal',
      Saldo_Inicial: 0,
      Saldo_Actual: 0,
      Activa: true,
      Estado: 'ABIERTA'
    }
  });
}

/**
 * Devuelve la caja activa (turno actual) o `null` si no hay ninguna abierta.
 * No crea caja: las operaciones de venta deben fallar con [CajaCerradaError]
 * cuando no exista un turno abierto.
 */
export async function obtenerCajaAbierta(
  tx: Prisma.TransactionClient | PrismaClient
) {
  return tx.caja.findFirst({ where: { Activa: true } });
}

/**
 * Valida que exista una caja abierta. Lanza [CajaCerradaError] si no la hay.
 * Además exige que ningún turno de una jornada ANTERIOR haya quedado abierto
 * (sin Fecha_Cierre): esa caja "colgada" exige arqueo Z antes de vender
 * (mandato FRENTE 2: bloquear facturación con arqueos pendientes).
 * Debe llamarse dentro de una transacción para evitar carreras.
 */
export async function exigirCajaAbierta(
  tx: Prisma.TransactionClient | PrismaClient
) {
  // ── Gate 1: arqueos pendientes de días anteriores ────────────────────────
  // Cualquier caja ABIERTA cuya apertura sea anterior a la jornada actual
  // carece de Fecha_Cierre conciliado → bloque total de nuevas ventas.
  const inicioHoy = inicioJornadaActual();
  const turnoHuerfano = await tx.caja.findFirst({
    where: {
      Activa: true,
      Fecha_Apertura: { lt: inicioHoy }
    },
    orderBy: { Fecha_Apertura: 'asc' }
  });
  if (turnoHuerfano) {
    throw new ArqueoPendienteError(turnoHuerfano.Caja_ID, turnoHuerfano.Fecha_Apertura);
  }

  // ── Gate 2: caja activa de la jornada actual ─────────────────────────────
  const caja = await obtenerCajaAbierta(tx);
  if (!caja) throw new CajaCerradaError();
  return caja;
}