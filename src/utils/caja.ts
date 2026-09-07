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
 * Debe llamarse dentro de una transacción para evitar carreras.
 */
export async function exigirCajaAbierta(
  tx: Prisma.TransactionClient | PrismaClient
) {
  const caja = await obtenerCajaAbierta(tx);
  if (!caja) throw new CajaCerradaError();
  return caja;
}