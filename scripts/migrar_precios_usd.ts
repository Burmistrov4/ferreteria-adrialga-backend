/**
 * Migración P0 — Estandariza el catálogo en USD.
 *
 * Contexto: `importar_epa.ts` guardaba `Precio_Venta = precioRef(USD) × tasa BCV`
 * (en bolívares), mientras el resto del sistema asume USD como referencia.
 * Resultado: precios inflados por la tasa (ej. $13702 por unas botas de ~$16)
 * y riesgo de doble conversión en el motor fiscal / Libro Diario.
 *
 * Esta migración NO adivina tasas: usa `Precio_Ref_USD` (que el scraper SÍ guardó
 * en USD) como fuente de verdad y lo copia a `Precio_Venta` y `Costo_Ultimo`.
 *
 * Idempotente: re-ejecutar no cambia nada. Solo toca el catálogo EPA
 * (`Codigo_EPA` no nulo); los productos cargados a mano no se modifican.
 *
 * Uso: node_modules/.bin/ts-node --transpile-only scripts/migrar_precios_usd.ts
 */
import { PrismaClient } from '@prisma/client';

const guard = require('./qa_guard.cjs');
{
  if (!process.env.DATABASE_URL) {
    try { require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); } catch {}
  }
  const _guardUrl = process.env.DATABASE_URL || '';
  if (!_guardUrl) {
    console.error('ABORTADO: DATABASE_URL no está definida (ni en entorno ni en .env).');
    process.exit(3);
  }
  const _guardV = guard.validarHostLocal(_guardUrl);
  if (!_guardV.ok) {
    console.error('ABORTADO: destino de base de datos no permitido (' + guard.sanitizar(_guardUrl) + '): ' + _guardV.error);
    process.exit(3);
  }
}
const prisma = new PrismaClient();

async function muestra(etiqueta: string): Promise<void> {
  const filas = await prisma.productos.findMany({
    where: { Codigo_EPA: { not: null } },
    select: {
      Producto_ID: true,
      Nombre: true,
      Precio_Venta: true,
      Precio_Ref_USD: true,
      Costo_Ultimo: true,
    },
    orderBy: { Producto_ID: 'asc' },
    take: 5,
  });
  console.log(`\n== ${etiqueta} ==`);
  for (const f of filas) {
    const ref = f.Precio_Ref_USD != null ? Number(f.Precio_Ref_USD).toFixed(2) : '—';
    console.log(
      `  #${f.Producto_ID} ${f.Nombre.slice(0, 34).padEnd(34)} ` +
        `Precio_Venta=${Number(f.Precio_Venta).toFixed(2).padStart(12)}  ` +
        `Ref_USD=${ref.padStart(8)}  ` +
        `Costo=${Number(f.Costo_Ultimo).toFixed(2)}`,
    );
  }
}

async function main(): Promise<void> {
  const totalEpa = await prisma.productos.count({ where: { Codigo_EPA: { not: null } } });
  const conRef = await prisma.productos.count({
    where: { Codigo_EPA: { not: null }, Precio_Ref_USD: { not: null } },
  });
  console.log(`Productos EPA: ${totalEpa} | con Precio_Ref_USD: ${conRef}`);

  await muestra('ANTES');

  const filas = await prisma.$executeRawUnsafe(
    `UPDATE productos
        SET Precio_Venta = Precio_Ref_USD,
            Costo_Ultimo  = Precio_Ref_USD
      WHERE Codigo_EPA IS NOT NULL
        AND Precio_Ref_USD IS NOT NULL
        AND Precio_Ref_USD > 0`,
  );
  console.log(`\n✔ Filas actualizadas (Bs -> USD): ${filas}`);

  await muestra('DESPUÉS');

  const pendientes = await prisma.$queryRawUnsafe<{ pendientes: bigint }[]>(
    `SELECT COUNT(*) AS pendientes FROM productos
      WHERE Codigo_EPA IS NOT NULL
        AND Precio_Ref_USD IS NOT NULL
        AND Precio_Venta <> Precio_Ref_USD`,
  );
  console.log(
    `\nVerificación: productos EPA con Precio_Venta != Ref_USD → ` +
      `${Number(pendientes[0]?.pendientes ?? 0)} (debe ser 0)`,
  );

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
