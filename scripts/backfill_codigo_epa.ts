/**
 * Backfill único (Fase B1): asigna Codigo_EPA a los productos ya importados
 * en la corrida anterior, que se crearon SIN Codigo_EPA (bug del importador).
 * El match es por Imagen_URL (= `/productos/{sku}.webp`, único por EPA) y,
 * si no hay imagen, por Nombre. Es idempotente: re-ejecutar no duplica.
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

async function main() {
  const epaDir = path.resolve(__dirname, '../data/epa');
  const recs: { sku: string; nombre: string; imagen_local: string | null }[] = [];
  if (fs.existsSync(epaDir)) {
    for (const f of fs.readdirSync(epaDir).filter((x) => x.endsWith('.json'))) {
      for (const l of fs.readFileSync(path.join(epaDir, f), 'utf-8').split('\n').filter(Boolean)) {
        const r = JSON.parse(l);
        recs.push({ sku: r.sku, nombre: r.nombre, imagen_local: r.imagen_local });
      }
    }
  }
  console.log(`Backfill sobre ${recs.length} registros EPA`);

  let okImg = 0, okNom = 0, fallidos = 0;
  for (const r of recs) {
    let actualizado = false;
    if (r.imagen_local) {
      const res = await prisma.productos.updateMany({
        where: { Imagen_URL: r.imagen_local, Codigo_EPA: null },
        data: { Codigo_EPA: r.sku },
      });
      if (res.count > 0) { okImg++; actualizado = true; }
    }
    if (!actualizado) {
      // Fallback por nombre (cuando no hay imagen local)
      const res = await prisma.productos.updateMany({
        where: { Nombre: r.nombre, Codigo_EPA: null },
        data: { Codigo_EPA: r.sku },
      });
      if (res.count > 0) { okNom++; actualizado = true; }
    }
    if (!actualizado) fallidos++;
  }
  console.log(`Backfill completo: porImagen=${okImg} porNombre=${okNom} sinMatch=${fallidos}`);
}

main().catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
