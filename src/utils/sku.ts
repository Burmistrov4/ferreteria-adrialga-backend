import { Prisma } from '@prisma/client';

/**
 * Calcula el siguiente SKU con formato {PREFIJO}-{YYYY}-{####} para una categoría.
 * Busca el mayor correlativo del año actual con patrón 'PREFIJO-YYYY-%' y suma 1.
 * @returns el SKU sugerido, o null si la categoría no existe.
 */
export async function siguienteSkuPorCategoria(
  tx: Prisma.TransactionClient,
  categoriaId: number
): Promise<string | null> {
  const categoria = await tx.categorias.findUnique({
    where: { Categoria_ID: categoriaId },
    select: { Prefijo_SKU: true }
  });
  if (!categoria) return null;

  const year = new Date().getFullYear();
  const patron = `${categoria.Prefijo_SKU}-${year}-%`;

  const [row] = await tx.$queryRaw<{ maxSku: string | null }[]>`
    SELECT MAX(SKU_Codigo) AS maxSku FROM Productos
    WHERE SKU_Codigo LIKE ${patron}`;

  const secuencia = row?.maxSku ? parseInt(row.maxSku.split('-')[2], 10) + 1 : 1;
  return `${categoria.Prefijo_SKU}-${year}-${String(secuencia).padStart(4, '0')}`;
}
