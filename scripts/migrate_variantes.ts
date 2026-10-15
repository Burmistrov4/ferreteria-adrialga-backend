/**
 * Backfill de inventario matricial (Tarea 5, fase 1).
 *
 * Recorre todos los productos y, para cada uno sin variantes, crea una
 * ProductoVariante "por defecto" que hereda SKU, costo, precio y stock del
 * registro lineal. No destructiva e idempotente: se puede ejecutar mil
 * veces sin duplicar filas (la variante existe → se omite).
 *
 * Ejecutar: npm run migrate:variantes
 */
// Salvaguarda de destino (ADR-002/007) ANTES de cargar la conexión Prisma.
/* eslint-disable @typescript-eslint/no-var-requires */
const guard = require('./qa_guard.cjs');
if (!process.env.DATABASE_URL) {
  try { require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); } catch {}
}
const _guardUrl = process.env.DATABASE_URL ?? '';
if (!_guardUrl) {
  console.error('ABORTADO: DATABASE_URL no está definida (ni en entorno ni en .env).');
  process.exit(3);
}
const _v = guard.validarHostLocal(_guardUrl);
if (!_v.ok) {
  console.error(`ABORTADO: destino de base de datos no permitido (${guard.sanitizar(_guardUrl)}): ${_v.error}`);
  process.exit(3);
}
const { prisma } = require('../src/config/db');
/* eslint-enable @typescript-eslint/no-var-requires */

async function main() {
  const productos = await prisma.productos.findMany({
    include: { producto_variantes: true },
  });

  let creadas = 0;
  let omitidas = 0;

  for (const p of productos) {
    if (p.producto_variantes.length > 0) {
      omitidas++;
      continue;
    }
    await prisma.producto_variantes.create({
      data: {
        Producto_ID: p.Producto_ID,
        SKU_Variante: `${p.SKU_Codigo}-VAR`,
        Costo_Unitario: p.Costo_Ultimo,
        Precio_Venta: p.Precio_Venta,
        Stock_Actual: p.Stock_Actual,
      },
    });
    creadas++;
  }

  console.log(`✅ Backfill de variantes: ${creadas} creada(s), ${omitidas} omitida(s) (producto ya era matricial o ya tenía su variante por defecto).`);
}

main()
  .catch((e) => {
    console.error('❌ Error en backfill de variantes:', e);
    process.exitCode = 1;
  })
  .finally(async () => await prisma.$disconnect());
