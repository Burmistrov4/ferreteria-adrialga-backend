/**
 * catalogo_demo_100.cjs — Recorte del catálogo de demostración a 100 productos.
 *
 * Contexto: la base `adrialga` local quedó con ~7.278 productos y ~698
 * categorías tras la importación EPA. Para uso real/presentación el usuario
 * pidió explícitamente: "reducirlo solo a 100 items" y poder filtrar por el
 * proveedor a quien se le compró.
 *
 * Método NO destructivo:
 *   - NO se borra nada. El catálogo es simplemente `Activo = (esté entre los
 *     100 elegidos)`. Los demás quedan con `Activo=false` (soft-delete). Toda la
 *     historia (facturas, notas, CxP) sigue íntegra y el inventario mostrado en
 *     la UI pasa a ser exactamente 100 activos.
 *   - Las categorías sin productos activos quedan con `Activo=false`.
 *
 * Selección (determinista, 100 ítems) sobre TODA la tabla, no solo sobre los
 * activos actuales — así el catálogo se puede re-elegir sin volver a importar:
 *   0) Se EXCLUYEN los artefactos de QA (ver `RE_FIXTURE`). Medido el
 *      2026-10-14: 46 de los 100 activos eran fixtures ("Producto Humo E2E",
 *      "Producto Costo Cero E2E", "Lámpara Matriz E2E", "ANTI-DEF Test"), que la
 *      regla anterior conservaba por tener historial de pruebas. En una
 *      presentación eso es la mitad del catálogo.
 *   1) Solo productos con `Precio_Venta > 0` (un producto sin precio aparece
 *      como $0.00 en el POS y en el inventario).
 *   2) Se prioriza: con historia comercial → con stock → con imagen EPA.
 *   3) El resto se reparte por categoría (round-robin) para que el demo cubra
 *      variedad.
 *
 * Seguridad (convención del proyecto):
 *   - Valida el destino con scripts/qa_guard.cjs ANTES de conectar.
 *   - Por defecto corre en MODO SECO (solo informa). Para APLICAR:
 *         set CONFIRMAR_RECORTE_100=SI && node scripts/catalogo_demo_100.cjs
 *   - Antes de escribir genera un respaldo JSON de revertibilidad en
 *     `backups/catalogo_previo_recorte_<epoch>.json` e imprime cómo restaurar
 *     (RESTAURAR_CON=...). Nunca imprime credenciales.
 */
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const guard = require('./qa_guard.cjs');

const APLICAR = process.env.CONFIRMAR_RECORTE_100 === 'SI';
const OBJETIVO = 100;
const RESTAURAR_CON = process.env.RESTAURAR_CON || null;

// Artefactos de pruebas automatizadas: nunca deben formar parte del catálogo.
// `E2E` cubre "Producto Humo E2E…", "Producto Costo Cero E2E", "Lámpara Matriz
// E2E"; `ANTI-DEF` cubre "ANTI-DEF Test". No se usa "humo" a secas para no
// descartar productos reales como un detector de humo.
const RE_FIXTURE = /(\bE2E\b)|(ANTI-DEF)|(\bPrueba\b)|(Costo Cero)/i;
const esFixture = (nombre) => RE_FIXTURE.test(nombre ?? '');

async function main() {
  // ── 0) Guard: destino debe ser loopback — nunca contra un MySQL remoto ──
  const url = process.env.DATABASE_URL || '';
  const v = guard.validarHostLocal(url);
  if (!v.ok) {
    console.error(
      `✖ ABORTADO (sin tocar la BD): ${v.error} | destino=${guard.sanitizar(url)}`
    );
    process.exit(3);
  }
  const u = new URL(guard.normalizarUrl(url));
  const base = guard.rutaLimpia(u);
  if (base !== 'adrialga' && base !== 'adrialga_qa') {
    console.error(`✖ ABORTADO: base inesperada '${base}'; se esperaba adrialga o adrialga_qa.`);
    process.exit(3);
  }

  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();

  try {
    // ── MODO RESTAURAR ──────────────────────────────────────────────────
    // El respaldo guarda qué IDs estaban activos ANTES. Restaurar = volver a
    // ese conjunto exacto (y desactivar el resto).
    if (RESTAURAR_CON) {
      if (!APLICAR) {
        console.error('Restaurar también requiere CONFIRMAR_RECORTE_100=SI');
        process.exit(3);
      }
      const file = path.resolve(process.cwd(), RESTAURAR_CON);
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const antes = data.productosActivosAntes ?? [];
      await prisma.$transaction([
        prisma.productos.updateMany({
          where: { Producto_ID: { in: antes } },
          data: { Activo: true },
        }),
        prisma.productos.updateMany({
          where: { Producto_ID: { notIn: antes } },
          data: { Activo: false },
        }),
        prisma.categorias.updateMany({
          where: { Categoria_ID: { in: data.categoriasActivasAntes ?? [] } },
          data: { Activo: true },
        }),
      ]);
      console.log(
        `✔ Restaurados ${antes.length} productos y ` +
          `${(data.categoriasActivasAntes ?? []).length} categorías desde:\n  ${file}`
      );
      return;
    }

    // ── 1) Estado previo ────────────────────────────────────────────────
    const todos = await prisma.productos.findMany({
      select: {
        Producto_ID: true,
        Nombre: true,
        Categoria_ID: true,
        Precio_Venta: true,
        Stock_Actual: true,
        Codigo_EPA: true,
        Activo: true,
        _count: {
          select: { detalle_facturas: true, detalle_notas_entrega: true },
        },
      },
      orderBy: { Producto_ID: 'asc' },
    });
    const activosAntes = todos.filter((p) => p.Activo).map((p) => p.Producto_ID);
    const catsAntes = await prisma.categorias.findMany({
      select: { Categoria_ID: true, Categoria_Padre_ID: true, Activo: true },
    });
    const catsActivasAntes = catsAntes.filter((c) => c.Activo).map((c) => c.Categoria_ID);
    console.log(
      `Catálogo actual: ${todos.length} productos en total, ${activosAntes.length} activos, ` +
        `${catsActivasAntes.length} categorías activas.`
    );

    // ── 2) Candidatos: reales y con precio ──────────────────────────────
    const fixtures = todos.filter((p) => esFixture(p.Nombre));
    const candidatos = todos.filter(
      (p) => !esFixture(p.Nombre) && Number(p.Precio_Venta) > 0
    );
    console.log(
      `Excluidos por ser artefactos de QA: ${fixtures.length}` +
        (fixtures.length ? ` (p.ej. "${fixtures[0].Nombre.slice(0, 50)}")` : '') +
        `\nCandidatos reales con precio > 0: ${candidatos.length}`
    );
    if (candidatos.length < OBJETIVO) {
      console.error(`✖ Solo hay ${candidatos.length} candidatos; se necesitan ${OBJETIVO}.`);
      process.exit(2);
    }

    // ── 3) Selección determinista ───────────────────────────────────────
    const puntaje = (p) =>
      (p._count.detalle_facturas > 0 || p._count.detalle_notas_entrega > 0 ? 4 : 0) +
      (p.Stock_Actual > 0 ? 2 : 0) +
      (p.Codigo_EPA ? 1 : 0);

    // 3a) Se conservan SIEMPRE los productos reales con historia comercial: son
    // los que sostienen las métricas del demo (ventas, ticket, arqueo, CxP).
    // Medido el 2026-10-14: solo 11 productos reales tienen historia (los otros
    // 46 con historia eran fixtures), así que forzarlos es determinante — sin
    // esto el catálogo quedaba con "0 con historia" y el demo perdía sus ventas.
    const conHistoriaReal = candidatos.filter(
      (p) => p._count.detalle_facturas > 0 || p._count.detalle_notas_entrega > 0
    );
    const elegidos = new Set(conHistoriaReal.map((p) => p.Producto_ID));

    // 3b) El resto por round-robin por categoría, ordenado por calidad: da
    // variedad y lo mejor de cada categoría entra primero.
    const porCat = new Map();
    for (const p of candidatos) {
      if (elegidos.has(p.Producto_ID)) continue;
      const k = p.Categoria_ID ?? 0;
      if (!porCat.has(k)) porCat.set(k, []);
      porCat.get(k).push(p);
    }
    for (const lista of porCat.values()) {
      lista.sort((a, b) => puntaje(b) - puntaje(a) || a.Producto_ID - b.Producto_ID);
    }
    const listas = [...porCat.values()].sort((a, b) => b.length - a.length);
    while (elegidos.size < OBJETIVO) {
      let avanzo = false;
      for (const lista of listas) {
        if (elegidos.size >= OBJETIVO) break;
        const p = lista.shift();
        if (p) {
          elegidos.add(p.Producto_ID);
          avanzo = true;
        }
      }
      if (!avanzo) break;
    }

    const elegidosArr = [...elegidos].sort((a, b) => a - b);
    const aActivar = todos
      .filter((p) => elegidos.has(p.Producto_ID) && !p.Activo)
      .map((p) => p.Producto_ID);
    const aDesactivar = todos
      .filter((p) => !elegidos.has(p.Producto_ID) && p.Activo)
      .map((p) => p.Producto_ID);
    const conHistoria = conHistoriaReal.length;

    console.log(
      `Selección: ${elegidos.size} elegidos (con historia comercial: ${conHistoria}).\n` +
        `  → a ACTIVAR   : ${aActivar.length}\n` +
        `  → a desactivar: ${aDesactivar.length}`
    );

    // ── 4) Categorías activas resultantes (árbol: hija→padres) ──────────
    const catDe = new Map(todos.map((p) => [p.Producto_ID, p.Categoria_ID]));
    const catsConProducto = new Set();
    for (const id of elegidosArr) {
      const c = catDe.get(id);
      if (c != null) catsConProducto.add(c);
    }
    const padresDe = new Map();
    for (const c of catsAntes) {
      if (c.Categoria_Padre_ID != null) padresDe.set(c.Categoria_ID, c.Categoria_Padre_ID);
    }
    const activas = new Set(catsConProducto);
    let huboCambio = true;
    while (huboCambio) {
      huboCambio = false;
      for (const id of [...activas]) {
        const padre = padresDe.get(id);
        if (padre != null && !activas.has(padre)) {
          activas.add(padre);
          huboCambio = true;
        }
      }
    }
    const catsDesactivar = catsAntes
      .filter((c) => c.Activo && !activas.has(c.Categoria_ID))
      .map((c) => c.Categoria_ID);
    const catsActivar = catsAntes
      .filter((c) => !c.Activo && activas.has(c.Categoria_ID))
      .map((c) => c.Categoria_ID);
    console.log(
      `Categorías: quedarían activas ${activas.size} (de ${catsActivasAntes.length}); ` +
        `se desactivarían ${catsDesactivar.length} y se reactivarían ${catsActivar.length}.`
    );

    // ── 5) Salida ───────────────────────────────────────────────────────
    if (!APLICAR) {
      console.log(
        '\nMODO SECO: no se escribió nada. Para aplicar:\n' +
          '  Windows cmd:  set CONFIRMAR_RECORTE_100=SI && node scripts\\catalogo_demo_100.cjs\n' +
          '  Git Bash:     CONFIRMAR_RECORTE_100=SI node scripts/catalogo_demo_100.cjs\n' +
          'Se generará un respaldo JSON restorable antes de escribir.'
      );
      return;
    }

    // Respaldo JSON de revertibilidad (soft-delete: basta guardar los IDs).
    const dir = path.resolve(__dirname, '..', 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `catalogo_previo_recorte_${Date.now()}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          fecha: new Date().toISOString(),
          base,
          productosActivosAntes: activosAntes,
          categoriasActivasAntes: catsActivasAntes,
          elegidos,
        },
        null,
        2
      )
    );

    await prisma.$transaction([
      prisma.productos.updateMany({
        where: { Producto_ID: { in: aActivar } },
        data: { Activo: true },
      }),
      prisma.productos.updateMany({
        where: { Producto_ID: { in: aDesactivar } },
        data: { Activo: false },
      }),
      prisma.categorias.updateMany({
        where: { Categoria_ID: { in: catsDesactivar } },
        data: { Activo: false },
      }),
      prisma.categorias.updateMany({
        where: { Categoria_ID: { in: catsActivar } },
        data: { Activo: true },
      }),
    ]);

    const activosDespues = await prisma.productos.count({ where: { Activo: true } });
    const catsDespues = await prisma.categorias.count({ where: { Activo: true } });
    const fixturesActivos = (
      await prisma.productos.findMany({
        where: { Activo: true },
        select: { Nombre: true },
      })
    ).filter((p) => esFixture(p.Nombre)).length;

    console.log(
      `\n✔ Aplicado: productos activos=${activosDespues} (objetivo ${OBJETIVO}), ` +
        `fixtures activos=${fixturesActivos}, categorías activas=${catsDespues}.\n` +
        `  Respaldo de revertibilidad: ${file}\n` +
        `  Restaurar: set CONFIRMAR_RECORTE_100=SI && set RESTAURAR_CON=${path.basename(file)} && node scripts\\catalogo_demo_100.cjs`
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error('Fallo del recorte (sin credenciales en el log):', e && e.message ? e.message : e);
  process.exit(1);
});
