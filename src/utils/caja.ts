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
 * Discriminador de canal: TRUE solo si el método de pago representa dinero
 * físico que entra/sale de la gaveta (Efectivo USD o Efectivo VES).
 * Los cobros digitales/bancarios (Pago Móvil, Punto de Venta, Zelle, etc.)
 * van al banco: se registran en movimientos_caja para auditoría, pero NO
 * alteran Saldo_Actual (el arqueo cuenta solo papel moneda).
 */
export function esEfectivo(metodo?: string | null): boolean {
  return (metodo ?? '').toLowerCase().includes('efectivo');
}

/**
 * Fecha (jornada) actual truncada a medianoche LOCAL de Venezuela.
 *
 * BUG CORREGIDO: antes se usaba medianoche UTC (`setUTCHours(0,0,0,0)`), y como
 * Venezuela es UTC-4 la "jornada" empezaba a las 20:00 locales. Eso hacía que
 * un turno abierto de noche contara para el día siguiente y BLOQUEARA la
 * apertura de la mañana siguiente (el cajero no entendía por qué "no lo dejaba
 * abrir/cerrar varias veces"). Venezuela no aplica DST → offset fijo UTC-4.
 */
export function inicioJornadaActual(): Date {
  const VET_OFFSET_MS = 4 * 60 * 60 * 1000; // Venezuela = UTC-4
  const local = new Date(Date.now() - VET_OFFSET_MS);
  local.setUTCHours(0, 0, 0, 0); // medianoche local expresada en UTC
  return new Date(local.getTime() + VET_OFFSET_MS);
}

/**
 * Error semántico: se intentó abrir un turno cuando YA existe uno abierto
 * (409). El catch del controlador lo traduce a respuesta de conflicto
 * amigable, sin caer en el 500 genérico.
 */
export class CajaYaAbiertaError extends Error {
  public status = 409;
  public payload: Record<string, unknown>;
  constructor(message: string, payload: Record<string, unknown> = {}) {
    super(message);
    this.name = 'CajaYaAbiertaError';
    this.payload = payload;
  }
}

/**
 * Opciones de transacción para operaciones que bloquean la fila/índice de
 * caja activa. Se fija REPEATABLE READ explícitamente: es el aislamiento por
 * defecto de InnoDB, bajo el cual un `SELECT ... FOR UPDATE` sobre el índice
 * no único `IDX_Caja_Activa(Activa)` toma next-key locks y BLOQUEA inserciones
 * concurrentes de otra fila con Activa=1 (anti-fantasma). Bajo READ COMMITTED
 * InnoDB desactiva gap locks y la carrera de doble apertura sería posible, así
 * que el nivel se declara acá y no "a confianza".
 */
export const TX_CAJA_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
} as const;

/** Forma cruda de una fila de `caja` leída con bloqueo (tipos del driver). */
interface FilaCajaCruda {
  Caja_ID: number;
  Nombre: string;
  Saldo_Inicial: Prisma.Decimal;
  Saldo_Actual: Prisma.Decimal;
  Fecha_Apertura: Date;
  Fecha_Cierre: Date | null;
  Activa: number | boolean; // TINYINT(1) llega como 0/1 vía $queryRaw
  Estado: string;
  Usuario_ID: number | null;
}

/**
 * Lectura BLOQUEANTE (`SELECT ... FOR UPDATE`) de todas las filas de caja
 * activas (normalmente 0 o 1). SERIALIZA el recurso "turno abierto":
 *
 *  - Dos `abrirCaja` concurrentes: ambos ejecutan el locking read sobre el
 *    índice Activa; bajo REPEATABLE READ el primero toma el gap lock y el
 *    segundo espera al commit. Al re-leer ve la fila nueva → 409. Resultado:
 *    exactamente una apertura exitosa (A-014).
 *  - `cerrarCaja`/`ingresarFondoCaja` y las ventas (que llaman
 *    `exigirCajaAbierta`) quedan serializados sobre la MISMA fila: si el
 *    cierre gana, la venta re-lee Activa=false → CajaCerradaError y viceversa
 *    (A-015). Ninguna venta se confirma sobre un turno ya cerrado.
 *
 * Usar SIEMPRE dentro de `prisma.$transaction(fn, TX_CAJA_OPTIONS)`.
 */
export async function bloquearCajasActivas(tx: Prisma.TransactionClient) {
  const filas = await tx.$queryRaw<FilaCajaCruda[]>`
    SELECT Caja_ID, Nombre, Saldo_Inicial, Saldo_Actual,
           Fecha_Apertura, Fecha_Cierre, Activa, Estado, Usuario_ID
    FROM caja
    WHERE Activa = 1
    FOR UPDATE
  `;
  return filas.map((f) => ({
    ...f,
    Activa: !!f.Activa,
    Fecha_Apertura: f.Fecha_Apertura ? new Date(f.Fecha_Apertura) : f.Fecha_Apertura,
    Fecha_Cierre: f.Fecha_Cierre ? new Date(f.Fecha_Cierre) : null,
  }));
}

/**
 * Detecta un conflicto de concurrencia benigno que permite reintentar:
 *  - P2010 con meta.code 1213 → DEADLOCK de InnoDB.
 *  - P2034 → "Transaction failed due to a write conflict or a deadlock"
 *    (MariaDB/MySQL lo reportan así tras un conflicto de serialización).
 * En ambos casos la transacción fallida ya hizo rollback y reintentarla es
 * seguro y produce el resultado correcto (el perdedor re-lee el estado y
 * devuelve 409 en vez de un 500 opaco).
 */
function esConflictoDeConcurrencia(error: unknown): boolean {
  const err = error as { code?: string; meta?: { code?: string } };
  return (
    (err?.code === 'P2010' && err?.meta?.code === '1213') ||
    err?.code === 'P2034'
  );
}

/**
 * Ejecuta una transacción de caja con REINTENTO ante DEADLOCK / conflicto de
 * escritura de MySQL/MariaDB. Motivo: el locking read `SELECT ... FOR UPDATE`
 * sobre el índice no único `IDX_Caja_Activa(Activa)` puede disparar un
 * deadlock (1213 → P2010) o un conflicto de escritura (P2034) cuando dos
 * operaciones de caja (apertura/apertura, cierre/cierre, ingreso/cierre)
 * compiten por el mismo registro. Es un conflicto de serialización BENIGNO:
 * el motor hace rollback de una de las dos transacciones. Reintentarla es la
 * solución canónica y produce el resultado correcto — el perdedor re-lee el
 * estado y devuelve 409 en vez de un 500 opaco.
 *
 * No reintenta errores de negocio (CajaYaAbiertaError, CajaCerradaError,
 * validaciones 422, etc.): esos deben propagarse tal cual.
 */
export async function withTxCaja<T>(
  prisma: PrismaClient,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  maxIntentos = 4
): Promise<T> {
  let ultimoError: unknown;
  for (let intento = 0; intento < maxIntentos; intento++) {
    try {
      return await prisma.$transaction(fn, TX_CAJA_OPTIONS);
    } catch (error) {
      if (esConflictoDeConcurrencia(error) && intento < maxIntentos - 1) {
        ultimoError = error;
        // Backoff corto: el rollback ya liberó los locks.
        await new Promise((r) => setTimeout(r, 40 * (intento + 1)));
        continue;
      }
      throw error;
    }
  }
  throw ultimoError;
}

/**
 * Igual que [withTxCaja] pero con opciones de transacción arbitrarias
 * (p. ej. `timeout`/`maxWait` de la venta). Se usa en rutas que abren su
 * propia transacción (facturación, notas) y quieren ser resilientes al
 * deadlock 1213 al competir con el cierre de caja.
 */
export async function reintentarEnDeadlock<T>(
  prisma: PrismaClient,
  options: Parameters<PrismaClient['$transaction']>[1],
  fn: (tx: Prisma.TransactionClient) => Promise<T>
): Promise<T> {
  let ultimoError: unknown;
  const MAX = 4;
  for (let intento = 0; intento < MAX; intento++) {
    try {
      return await prisma.$transaction(fn, options);
    } catch (error) {
      const err = error as { code?: string; meta?: { code?: string } };
      if (
        ((err?.code === 'P2010' && err?.meta?.code === '1213') ||
          err?.code === 'P2034') &&
        intento < MAX - 1
      ) {
        ultimoError = error;
        await new Promise((r) => setTimeout(r, 40 * (intento + 1)));
        continue;
      }
      throw error;
    }
  }
  throw ultimoError;
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
  // Los turning signals de apertura/cierre y las ventas deben serializarse
  // sobre la misma fila de caja. Con $queryRaw (locking read) solo es válido
  // dentro de una transacción interactiva; el cliente global `prisma` no la
  // es, así que ahí se mantiene la lectura simple (rutas de solo lectura).
  const esTransaccion = !('$connect' in (tx as PrismaClient));

  if (esTransaccion) {
    const activas = await bloquearCajasActivas(tx as Prisma.TransactionClient);
    const inicioHoy = inicioJornadaActual();

    // ── Gate 1: arqueos pendientes de días anteriores ──────────────────────
    // Cualquier caja ABIERTA cuya apertura sea anterior a la jornada actual
    // carece de Fecha_Cierre conciliado → bloque total de nuevas ventas.
    const turnoHuerfano = activas.find(
      (c) => c.Fecha_Apertura < inicioHoy
    );
    if (turnoHuerfano) {
      throw new ArqueoPendienteError(turnoHuerfano.Caja_ID, turnoHuerfano.Fecha_Apertura);
    }

    // ── Gate 2: caja activa de la jornada actual (bajo bloqueo) ────────────
    const caja = activas[0];
    if (!caja) throw new CajaCerradaError();
    return caja;
  }

  // ── Rama no transaccional (cliente global): lectura simple, sin locks ────
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
  const caja = await obtenerCajaAbierta(tx);
  if (!caja) throw new CajaCerradaError();
  return caja;
}