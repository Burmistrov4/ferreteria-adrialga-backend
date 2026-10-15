import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';
dotenv.config();
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

async function main() {
  const cats = await prisma.categorias.findMany({
    select: { Categoria_ID: true, Nombre: true, Prefijo_SKU: true },
    orderBy: { Categoria_ID: 'asc' },
  });

  // Prefijos duplicados (colisión real de unicidad de negocio)
  const vistos = new Map<string, number>();
  for (const c of cats) {
    const p = (c.Prefijo_SKU ?? '').trim().toUpperCase();
    if (!p) continue;
    vistos.set(p, (vistos.get(p) ?? 0) + 1);
  }
  const duplicados = [...vistos.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]);
  console.log(`Total categorías: ${cats.length}`);
  console.log(`Prefijos distintos no vacíos: ${vistos.size}`);
  console.log(`Prefijos DUPLICADOS: ${duplicados.length}`);
  for (const [p, n] of duplicados.slice(0, 30)) console.log(`  · "${p}" ×${n}`);

  const ids = [26, 38, 41, 45, 66, 101, 168, 219];
  console.log('\nEstado actual de categorías muestra:');
  for (const c of cats.filter((x) => ids.includes(x.Categoria_ID))) {
    console.log(`  cat ${c.Categoria_ID} "${c.Nombre}": Prefijo_SKU="${c.Prefijo_SKU}"`);
  }

  // Productos con SKU no conforme (patrón {PREFIJO}-{YYYY}-{####})
  const YEAR = new Date().getFullYear();
  const prods = await prisma.productos.findMany({ select: { SKU_Codigo: true, Categoria_ID: true } });
  const prefPorCat = new Map(cats.map((c) => [c.Categoria_ID, (c.Prefijo_SKU ?? '').trim().toUpperCase()]));
  let noConformes = 0;
  const ejemplos: string[] = [];
  for (const p of prods) {
    const sku = (p.SKU_Codigo ?? '').trim();
    const pref = prefPorCat.get(p.Categoria_ID) ?? '';
    if (!sku || !pref) { noConformes++; if (ejemplos.length < 5) ejemplos.push(`#${p.Categoria_ID} sku="${sku}" pref="${pref}"`); continue; }
    const rx = new RegExp(`^${pref}-${YEAR}-\\d{4}$`);
    if (!rx.test(sku)) { noConformes++; if (ejemplos.length < 10) ejemplos.push(`#${p.Categoria_ID} sku="${sku}" pref="${pref}"`); }
  }
  console.log(`\nProductos totales: ${prods.length}`);
  console.log(`Productos NO conformes (vs prefijo actual de su categoría): ${noConformes}`);
  for (const e of ejemplos) console.log(`  · ${e}`);
}
main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
