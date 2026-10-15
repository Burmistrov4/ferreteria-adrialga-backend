// Limpieza del residuo REAL que dejó el smoke E2E interrumpido.
//
// Historia (para que nadie repita el error): al verificar el escape
// ALLOW_SMOKE_EN_ADRIALGA=SI se corrió smoke_e2e.js contra `adrialga` y se cortó
// con `timeout`, así que su bloque de limpieza (finally) nunca corrió.
//
// ⚠️ PRIMER INTENTO FALLIDO (no se aplicó): se usaron umbrales "ID > N" tomados
// de unos CONTADOS (productos=7278, notas=37, facturas=122, movimientos=166).
// Un conteo NO es un ID máximo: las tablas tienen huecos e IDs mucho más altos.
// Eso habría borrado 60 filas de datos LEGÍTIMOS (facturas #123..#707, cobros de
// caja, notas de entrega reales y el producto #7281 del catálogo). Regla que
// queda: NUNCA derivar un umbral de borrado de un COUNT(*); identificar la fila
// por su contenido y exigir que no tenga referencias.
//
// Criterio de este script (conservador y verificable): se elimina SOLO un
// producto que (a) su nombre coincide con el patrón de artefactos de QA,
// (b) NO tiene ninguna referencia (ventas, compras, variantes) y
// (c) tiene stock 0. Sin referencias y sin stock no hay trazabilidad que perder.
//
// Solo lectura por defecto. Uso:
//   node scripts/_cleanup_smoke_residue.cjs
//   CONFIRMAR_LIMPIEZA=SI node scripts/_cleanup_smoke_residue.cjs
'use strict';
require('dotenv').config();
const guard = require('./qa_guard.cjs');

const APLICAR = process.env.CONFIRMAR_LIMPIEZA === 'SI';
const RE_FIXTURE = /(\bE2E\b)|(ANTI-DEF)|(\bPrueba\b)|(Costo Cero)/i;

(async () => {
  const url = process.env.DATABASE_URL || '';
  const v = guard.validarHostLocal(url);
  if (!v.ok) {
    console.error(`✖ ABORTADO: ${v.error}`);
    process.exit(3);
  }
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();

  try {
    const todos = await prisma.productos.findMany({
      select: {
        Producto_ID: true, Nombre: true, SKU_Codigo: true, Activo: true,
        Stock_Actual: true, Precio_Venta: true,
        _count: { select: { detalle_facturas: true, detalle_notas_entrega: true, producto_variantes: true } },
      },
    });

    const fixtures = todos.filter((p) => RE_FIXTURE.test(p.Nombre ?? ''));
    const sinReferencias = fixtures.filter(
      (p) =>
        p._count.detalle_facturas === 0 &&
        p._count.detalle_notas_entrega === 0 &&
        p._count.producto_variantes === 0
    );
    const borrables = sinReferencias.filter((p) => Number(p.Stock_Actual) === 0);
    const retenidos = sinReferencias.filter((p) => Number(p.Stock_Actual) !== 0);

    console.log(`Artefactos de QA en la tabla : ${fixtures.length}`);
    console.log(`  sin referencias             : ${sinReferencias.length}`);
    console.log(`  → borrables (sin stock)     : ${borrables.length}`);
    console.log(`  → retenidos (tienen stock)  : ${retenidos.length}`);
    for (const p of borrables) {
      console.log(`     borrable  #${p.Producto_ID}  activo=${p.Activo}  stock=${p.Stock_Actual}  precio=${p.Precio_Venta}  "${p.Nombre}"`);
    }
    for (const p of retenidos) {
      console.log(`     retenido  #${p.Producto_ID}  activo=${p.Activo}  stock=${p.Stock_Actual}  "${p.Nombre}" (se desactivará, no se borra)`);
    }
    const conRef = fixtures.filter((p) => !sinReferencias.includes(p));
    console.log(`  con referencias (historia): ${conRef.length} — NO se tocan`);

    if (borrables.length === 0 && retenidos.length === 0) {
      console.log('\n✔ Sin residuo: nada que limpiar.');
      return;
    }
    if (!APLICAR) {
      console.log('\nMODO SECO. Para aplicar:\n  CONFIRMAR_LIMPIEZA=SI node scripts/_cleanup_smoke_residue.cjs');
      return;
    }

    await prisma.$transaction([
      prisma.productos.deleteMany({ where: { Producto_ID: { in: borrables.map((p) => p.Producto_ID) } } }),
      prisma.productos.updateMany({ where: { Producto_ID: { in: retenidos.map((p) => p.Producto_ID) } }, data: { Activo: false } }),
    ]);

    const activos = await prisma.productos.count({ where: { Activo: true } });
    const activosFixture = (
      await prisma.productos.findMany({ where: { Activo: true }, select: { Nombre: true } })
    ).filter((p) => RE_FIXTURE.test(p.Nombre ?? '')).length;
    console.log(
      `\n✔ Limpieza aplicada: ${borrables.length} borrados, ${retenidos.length} desactivados.` +
        `\n  Productos activos=${activos}, fixtures activos=${activosFixture}`
    );
  } finally {
    await prisma.$disconnect();
  }
})().catch((e) => {
  console.error('ERROR:', e && e.message ? e.message : e);
  process.exit(1);
});
