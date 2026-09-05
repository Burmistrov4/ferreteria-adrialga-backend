import { Prisma } from '@prisma/client';

/**
 * Asegura que exista una Caja Principal activa. Si ninguna caja está activa,
 * se crea con saldo 0. Reutilizable dentro de una transacción (tx) o con el
 * cliente global (prisma).
 *
 * @param tx cliente Prisma (transacción o global)
 * @returns la caja principal activa
 */
export async function asegurarCajaPrincipal(
  tx: Prisma.TransactionClient
) {
  const existente = await tx.caja.findFirst({ where: { Activa: true } });
  if (existente) return existente;

  return tx.caja.create({
    data: {
      Nombre: 'Caja Principal',
      Saldo_Inicial: 0,
      Saldo_Actual: 0,
      Activa: true
    }
  });
}