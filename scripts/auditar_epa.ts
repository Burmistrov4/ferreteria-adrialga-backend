/**
 * Auditoría de integridad del catálogo EPA (Fase B1, MISIÓN 2).
 * - Sin subcategorías huerfanas (FK Categoria_Padre_ID resuelve).
 * - Precio_Ref_USD coincide con el JSON-LD del scraper (spot-check).
 * - Conteos: productos, categorías (raíz vs hoja), jerarquía bajo Automotriz.
 * - Imagen local apunta a /productos/*.webp.
 */
import { PrismaClient } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';

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

interface Rec { sku: string; precio_usd: number | null; nombre: string; jerarquia: string[]; imagen_local: string | null; }

async function main() {
  const epaDir = path.resolve(__dirname, '../data/epa');
  const recs: Rec[] = [];
  if (fs.existsSync(epaDir)) {
    for (const f of fs.readdirSync(epaDir).filter((x) => x.endsWith('.json'))) {
      for (const l of fs.readFileSync(path.join(epaDir, f), 'utf-8').split('\n').filter(Boolean)) {
        const r = JSON.parse(l);
        recs.push({ sku: r.sku, precio_usd: r.precio_usd, nombre: r.nombre, jerarquia: r.jerarquia, imagen_local: r.imagen_local });
      }
    }
  }

  const totalProd = await prisma.productos.count();
  const epaProd = await prisma.productos.count({ where: { Codigo_EPA: { not: null } } });

  // 1) Integridad de subcategorías (padre resuelve)
  const orphan = await prisma.$queryRawUnsafe<{ n: number }[]>(
    `SELECT COUNT(*) AS n FROM categorias c
     LEFT JOIN categorias p ON c.Categoria_Padre_ID = p.Categoria_ID
     WHERE c.Categoria_Padre_ID IS NOT NULL AND p.Categoria_ID IS NULL`,
  );
  const orphanN = Number((orphan[0] as any).n);

  // 2) Spot-check Precio_Ref_USD vs JSON-LD
  const muestras = recs.slice(0, 5);
  const chequeos: any[] = [];
  for (const r of muestras) {
    const p = await prisma.productos.findUnique({ where: { Codigo_EPA: r.sku } });
    if (!p) { chequeos.push({ sku: r.sku, ok: false, motivo: 'no en BD' }); continue; }
    const enBD = p.Precio_Ref_USD == null ? null : Number(p.Precio_Ref_USD);
    chequeos.push({
      sku: r.sku,
      jsonld: r.precio_usd,
      bd: enBD,
      ok: r.precio_usd === enBD,
      imagen: p.Imagen_URL,
      cat: p.Categoria_ID,
    });
  }

  // 3) Conteos de categorías
  const totalCat = await prisma.categorias.count();
  const raices = await prisma.categorias.count({ where: { Categoria_Padre_ID: null } });
  const hojas = await prisma.categorias.count({ where: { Categoria_Padre_ID: { not: null } } });

  // 4) Jerarquía bajo Automotriz (raíz) — conteo recursivo de descendientes
  const auto = await prisma.categorias.findFirst({ where: { Nombre: 'Automotriz', Categoria_Padre_ID: null } });
  async function descIds(id: number): Promise<number[]> {
    const hijas = await prisma.categorias.findMany({ where: { Categoria_Padre_ID: id }, select: { Categoria_ID: true } });
    const out: number[] = [id];
    for (const h of hijas) out.push(...(await descIds(h.Categoria_ID)));
    return out;
  }
  const hijasAuto = auto ? await prisma.categorias.count({ where: { Categoria_Padre_ID: auto.Categoria_ID } }) : 0;
  const prodAuto = auto
    ? await prisma.productos.count({ where: { Categoria_ID: { in: await descIds(auto.Categoria_ID) } } })
    : 0;

  // 5) Imágenes locales apuntan a .webp
  const noWebp = await prisma.productos.count({ where: { Codigo_EPA: { not: null }, Imagen_URL: { not: { endsWith: '.webp' } } } });

  console.log('===== AUDITORÍA EPA =====');
  console.log(`Productos totales BD:           ${totalProd}`);
  console.log(`Productos con Codigo_EPA (EPA): ${epaProd}`);
  console.log(`Categorías totales:             ${totalCat} (raíces=${raices}, hojas=${hojas})`);
  console.log(`Subcategorías huerfanas (FK):   ${orphanN}  ${orphanN === 0 ? '✅' : '❌'}`);
  console.log(`Imagen sin .webp:               ${noWebp}  ${noWebp === 0 ? '✅' : '❌'}`);
  console.log(`Automotriz -> subcats:          ${hijasAuto}, productos en árbol: ${prodAuto}`);
  console.log('\n-- Spot-check Precio_Ref_USD (JSON-LD vs BD) --');
  for (const c of chequeos) {
    console.log(`  ${c.sku}: jsonld=${c.jsonld} bd=${c.bd} ${c.ok ? '✅' : '❌ ' + (c.motivo || '')} | img=${c.imagen}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
