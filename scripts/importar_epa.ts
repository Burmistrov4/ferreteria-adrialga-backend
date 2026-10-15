/**
 * Importador del catálogo EPA (Fase B1) — lee data/epa/*.json (NDJSON
 * producido por el scraper Python scrape_epa.py) y hace UPSERT idempotente
 * en la BD. Mantiene retrocompatibilidad con data/automotriz.json (prueba
 * de humo inicial) si no existiera la carpeta data/epa/.
 *
 * - Crea la jerarquía de categorías auto-referencial (Categoria_Padre_ID)
 *   a partir del breadcrumb de cada producto.
 * - Asigna Prefijo_SKU único por categoría hoja.
 * - SKU interno: {Prefijo}-{AAAA}-{####} (secuencial por prefijo).
 * - Codigo_EPA es la clave de upsert (idempotente: re-ejecutar actualiza).
 * - Precio_Ref_USD = precio JSON-LD (USD). Precio_Venta = USD (referencia
 *   canónica del sistema; el TPV convierte a Bs con la tasa BCV viva al vender).
 *
 * Uso: npm run importar:epa
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

interface Rec {
  sku: string;
  nombre: string;
  marca: string | null;
  precio_usd: number | null;
  moneda: string;
  url_ficha: string;
  imagen_original: string | null;
  imagen_local: string | null;
  jerarquia: string[]; // [Categoria, Sub1, Sub2, ...]
}

// Quita acentos y deja solo letras -> 3 chars de prefijo SKU.
function derivarPrefijo(nombre: string): string {
  const limpio = nombre
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '');
  if (limpio.length >= 3) return limpio.slice(0, 3);
  return (limpio + 'GEN').slice(0, 3);
}

const catCache = new Map<string, number>(); // key: `${padreId}|${nombre}` -> Categoria_ID

async function upsertCategoria(
  nombre: string,
  padreId: number | null,
  prefijo: string,
): Promise<number> {
  const key = `${padreId ?? 'root'}|${nombre}`;
  const cached = catCache.get(key);
  if (cached) return cached;

  const existentes = await prisma.categorias.findMany({ where: { Nombre: nombre } });
  const cat = existentes.find((c) => c.Categoria_Padre_ID === padreId);
  let id: number;
  if (!cat) {
    const creada = await prisma.categorias.create({
      data: { Nombre: nombre, Categoria_Padre_ID: padreId, Prefijo_SKU: prefijo },
    });
    id = creada.Categoria_ID;
  } else {
    id = cat.Categoria_ID;
    if ((!cat.Prefijo_SKU || cat.Prefijo_SKU === 'GEN') && prefijo !== 'GEN') {
      await prisma.categorias.update({
        where: { Categoria_ID: id },
        data: { Prefijo_SKU: prefijo },
      });
    }
  }
  catCache.set(key, id);
  return id;
}

async function resolverJerarquia(jerarquia: string[]): Promise<number> {
  let padreId: number | null = null;
  let leafId = 0;
  for (const nombre of jerarquia) {
    const n = nombre.trim();
    if (!n) continue;
    const prefijo = derivarPrefijo(n);
    leafId = await upsertCategoria(n, padreId, prefijo);
    padreId = leafId;
  }
  return leafId;
}

async function nextSku(prefix: string): Promise<string> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows: any[] = await prisma.$queryRawUnsafe(
    'SELECT SKU_Codigo FROM productos WHERE SKU_Codigo LIKE ? ORDER BY SKU_Codigo DESC LIMIT 1',
    `${prefix}-%`,
  );
  const year = new Date().getFullYear();
  let seq = 1;
  if (rows && rows.length) {
    const m = /-(\d+)$/.exec(rows[0].SKU_Codigo);
    if (m) seq = parseInt(m[1], 10) + 1;
  }
  return `${prefix}-${year}-${String(seq).padStart(4, '0')}`;
}

async function main() {
  const epaDir = path.resolve(__dirname, '../data/epa');
  let archivos: string[] = [];
  if (fs.existsSync(epaDir)) {
    archivos = fs.readdirSync(epaDir).filter((f) => f.endsWith('.json'))
      .map((f) => path.join(epaDir, f));
  }
  // Retrocompatibilidad: si no hay carpeta data/epa, usa data/automotriz.json
  if (archivos.length === 0) {
    const legacy = path.resolve(__dirname, '../data/automotriz.json');
    if (fs.existsSync(legacy)) archivos = [legacy];
  }
  if (archivos.length === 0) {
    console.error('No hay NDJSON de EPA (data/epa/*.json ni data/automotriz.json) — ejecuta primero el scraper Python.');
    process.exit(1);
  }

  const recs: Rec[] = [];
  for (const file of archivos) {
    const lineas = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    for (const l of lineas) {
      try { recs.push(JSON.parse(l)); } catch { /* línea rota: ignorar */ }
    }
  }
  console.log(`Leyendo ${recs.length} registros de ${archivos.length} archivo(s) EPA`);

  // La tasa BCV ya NO fija Precio_Venta: el catálogo se estandariza en USD y el
  // TPV convierte a Bs con la tasa viva al vender. Se registra solo de referencia.
  const tasaRow = await prisma.tasas_bcv.findFirst({ orderBy: { Fecha: 'desc' } });
  const tasa = tasaRow ? Number(tasaRow.Tasa) : 1.0;
  if (!tasaRow) console.warn('⚠ No hay tasa BCV registrada (no afecta: el catálogo es USD)');
  console.log(`Tasa BCV activa (solo referencia): ${tasa}`);

  let creados = 0;
  let actualizados = 0;
  for (const rec of recs) {
    const leafId = await resolverJerarquia(rec.jerarquia);
    const prefijo = derivarPrefijo(
      rec.jerarquia[rec.jerarquia.length - 1] || rec.nombre,
    );
    const precioRef = rec.precio_usd != null ? rec.precio_usd : 0;
    // USD (referencia canónica). Ya NO se multiplica por la tasa BCV.
    const precioVenta = Math.round(precioRef * 100) / 100;

    const data = {
      Codigo_EPA: rec.sku, // clave de upsert idempotente (igual en create/update)
      Nombre: rec.nombre,
      Marca: rec.marca,
      Precio_Ref_USD: precioRef,
      Precio_Venta: precioVenta,
      Costo_Ultimo: precioVenta,
      Imagen_URL: rec.imagen_local,
      Categoria_ID: leafId,
      Activo: true,
    };

    const existente = rec.sku
      ? await prisma.productos.findUnique({ where: { Codigo_EPA: rec.sku } })
      : null;

    if (existente) {
      await prisma.productos.update({
        where: { Producto_ID: existente.Producto_ID },
        data,
      });
      actualizados++;
    } else {
      const sku = await nextSku(prefijo);
      await prisma.productos.create({
        data: { ...data, SKU_Codigo: sku, Stock_Actual: 0, Stock_Minimo: 5 },
      });
      creados++;
    }
  }

  console.log(`\n== IMPORTACIÓN COMPLETA == creados=${creados} actualizados=${actualizados}`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
