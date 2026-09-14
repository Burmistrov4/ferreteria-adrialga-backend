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
import { prisma } from '../src/config/db';

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
