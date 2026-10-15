/**
 * normalizar_skus.ts — Normaliza los prefijos de categoría y los SKU de producto.
 *
 * Uso:
 *   npm run skus:normalizar             # SIMULACIÓN (no escribe nada)
 *   npm run skus:normalizar -- --apply  # aplica los cambios
 *
 * Qué corrige:
 *  1) Prefijo_SKU único por categoría. Hoy 7 categorías comparten "GEN", así que
 *     la secuencia "por categoría" es en realidad global y los SKU nuevos salen
 *     mal. El prefijo se deriva del nombre si falta o si está repetido.
 *  2) SKU de producto que no cumple {Prefijo}-{YYYY}-{####}: se renombra al
 *     siguiente correlativo libre de su categoría (sin colisiones).
 *
 * No toca los SKU ya conformes.
 */
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
const APLICAR = process.argv.includes('--apply');
/** Aplica solo los prefijos de categoría (deja los SKU de producto intactos). */
const SOLO_PREFIJOS = process.argv.includes('--solo-prefijos');
const YEAR = new Date().getFullYear();
const patron = (prefijo: string) => new RegExp(`^${prefijo}-${YEAR}-\\d{4}$`);

const limpiar = (s: string): string =>
  (s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');

/** Prefijo único de 3+ letras derivado del nombre (extiende o numera si colisiona). */
function derivarPrefijo(nombre: string, usados: Set<string>): string {
  const base = limpiar(nombre) || 'GEN';
  for (let len = 3; len <= base.length; len++) {
    const cand = base.slice(0, len);
    if (!usados.has(cand)) return cand;
  }
  const stem = base.slice(0, 3);
  let n = 2;
  while (usados.has(`${stem}${n}`)) n++;
  return `${stem}${n}`;
}

const nombreCat = (c: any): string => c.Nombre_Categoria ?? c.Nombre ?? '';

/** "GEN" es el prefijo genérico por defecto: se re-deriva del nombre real. */
const esGenerico = (p: string): boolean => !p || p === 'GEN';

async function main() {
  const categorias = await prisma.categorias.findMany({
    orderBy: { Categoria_ID: 'asc' },
  });

  const usados = new Set<string>();
  const cambiosCat: Array<{ id: number; nombre: string; de: string | null; a: string }> = [];
  const prefijoPorCat = new Map<number, string>();

  for (const c of categorias) {
    const actual = ((c as any).Prefijo_SKU ?? '').trim().toUpperCase();
    let final = actual;
    if (esGenerico(actual) || usados.has(actual)) {
      final = derivarPrefijo(nombreCat(c), usados);
      cambiosCat.push({
        id: c.Categoria_ID,
        nombre: nombreCat(c),
        de: actual || null,
        a: final,
      });
    }
    usados.add(final);
    prefijoPorCat.set(c.Categoria_ID, final);
  }

  const productos = await prisma.productos.findMany({
    orderBy: { Producto_ID: 'asc' },
  });

  // Conjunto GLOBAL de SKU actuales: garantiza unicidad absoluta al renombrar
  // (el seq por categoría solo no basta porque pueden existir SKU legados con
  // el mismo prefijo en otra categoría → colisión P2002 de clave única).
  const ocupados = new Set<string>(
    productos.map((p: any) => ((p as any).SKU_Codigo ?? '').trim()).filter(Boolean),
  );

  // Secuencia máxima ya existente por prefijo (global).
  const seq = new Map<string, number>();
  for (const sku of ocupados) {
    for (const pref of prefijoPorCat.values()) {
      const m = new RegExp(`^${pref}-${YEAR}-(\\d{4})$`).exec(sku);
      if (m) seq.set(pref, Math.max(seq.get(pref) ?? 0, parseInt(m[1], 10)));
    }
  }

  const cambiosProd: Array<{ id: number; nombre: string; de: string; a: string }> = [];
  for (const p of productos) {
    const pref = prefijoPorCat.get((p as any).Categoria_ID ?? -1);
    if (!pref) continue;
    const sku = ((p as any).SKU_Codigo ?? '').trim();
    if (patron(pref).test(sku)) continue; // ya conforme
    // Encuentra el primer correlativo libre (evita colisión con SKU existentes
    // o con otros renombres de esta misma corrida).
    let n = (seq.get(pref) ?? 0) + 1;
    let candidato = '';
    while (true) {
      candidato = `${pref}-${YEAR}-${String(n).padStart(4, '0')}`;
      if (!ocupados.has(candidato)) break;
      n++;
    }
    seq.set(pref, n);
    ocupados.add(candidato);
    cambiosProd.push({
      id: p.Producto_ID,
      nombre: (p as any).Nombre ?? '',
      de: sku,
      a: candidato,
    });
  }

  console.log(`\n=== ${APLICAR ? 'APLICANDO CAMBIOS' : 'SIMULACIÓN (dry-run)'} ===`);
  console.log(`\nPrefijos de categoría a corregir: ${cambiosCat.length}`);
  for (const c of cambiosCat) {
    console.log(`  · cat ${c.id} "${c.nombre}": ${c.de ?? '(vacío)'} → ${c.a}`);
  }
  console.log(`\nSKU de producto a normalizar: ${cambiosProd.length} de ${productos.length}`);
  for (const p of cambiosProd) {
    console.log(`  · #${p.id} "${p.nombre.slice(0, 34)}": ${p.de || '(vacío)'} → ${p.a}`);
  }

  if (!APLICAR) {
    console.log('\n(dry-run) No se escribió nada. Repite con --apply para aplicar.');
    return;
  }

  // Prisma cierra la transacción interactiva tras 5 s por defecto (P2028).
  // Con 450 prefijos + 5.092 SKU excedemos ese plazo, así que procesamos en
  // lotes acotados, cada uno en su propia transacción con timeout amplio.
  // El script es idempotente: re-ejecutar solo corrige lo que falte.
  const LOTE = 400;
  const timeoutMs = 120_000;

  const aplicarLote = async (
    ops: Array<() => Promise<unknown>>,
  ): Promise<void> => {
    for (let i = 0; i < ops.length; i += LOTE) {
      const chunk = ops.slice(i, i + LOTE).map((op) => op());
      await prisma.$transaction(chunk, { timeout: timeoutMs });
    }
  };

  let aplicadosCat = 0;
  let aplicadosProd = 0;

  if (cambiosCat.length) {
    console.log(`\nAplicando ${cambiosCat.length} prefijos de categoría...`);
    await aplicarLote(
      cambiosCat.map(
        (c) => () =>
          prisma.categorias.update({
            where: { Categoria_ID: c.id },
            data: { Prefijo_SKU: c.a },
          }),
      ),
    );
    aplicadosCat = cambiosCat.length;
  }

  if (!SOLO_PREFIJOS && cambiosProd.length) {
    console.log(`Aplicando ${cambiosProd.length} SKU de producto...`);
    await aplicarLote(
      cambiosProd.map(
        (p) => () =>
          prisma.productos.update({
            where: { Producto_ID: p.id },
            data: { SKU_Codigo: p.a },
          }),
      ),
    );
    aplicadosProd = cambiosProd.length;
  }

  console.log(
    SOLO_PREFIJOS
      ? `\n✔ ${aplicadosCat} prefijos de categoría aplicados (SKU sin tocar por --solo-prefijos).`
      : `\n✔ Cambios aplicados: ${aplicadosCat} categorías, ${aplicadosProd} productos.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
