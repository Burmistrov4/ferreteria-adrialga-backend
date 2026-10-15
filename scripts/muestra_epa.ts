/**
 * Muestra 2 registros reales del catálogo EPA con su árbol jerárquico completo
 * (raíz > ... > hoja), para el reporte de la MISIÓN 4 (Fase B1).
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

async function rutaCategoria(id: number): Promise<string[]> {
  const nombres: string[] = [];
  let cur: number | null = id;
  for (let i = 0; i < 12 && cur != null; i++) {
    const c = await prisma.categorias.findUnique({ where: { Categoria_ID: cur } });
    if (!c) break;
    nombres.unshift(c.Nombre);
    if (c.Categoria_Padre_ID == null) break;
    cur = c.Categoria_Padre_ID;
  }
  return nombres;
}

async function main() {
  const skus = ['VE-1003591', 'VE-0227094']; // automotriz y pinturas
  for (const sku of skus) {
    const p = await prisma.productos.findUnique({ where: { Codigo_EPA: sku } });
    if (!p) { console.log(`${sku}: no encontrado`); continue; }
    const ruta = await rutaCategoria(p.Categoria_ID);
    const usd = p.Precio_Ref_USD == null ? null : Number(p.Precio_Ref_USD);
    const bs = p.Precio_Venta == null ? null : Number(p.Precio_Venta);
    console.log('---------------------------------------------');
    console.log(`Nombre:          ${p.Nombre}`);
    console.log(`Codigo_EPA:      ${p.Codigo_EPA}`);
    console.log(`SKU interno:     ${p.SKU_Codigo}`);
    console.log(`Marca:           ${p.Marca}`);
    console.log(`Precio_Ref_USD:  ${usd}`);
    console.log(`Precio_Venta Bs: ${bs}`);
    console.log(`Imagen_URL:      ${p.Imagen_URL}`);
    console.log(`Árbol:           ${ruta.join('  >  ')}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
