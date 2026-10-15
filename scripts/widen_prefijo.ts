/**
 * widen_prefijo.ts — Ensancha Prefijo_SKU de VARCHAR(8) a VARCHAR(30).
 *
 * Causa raíz del desperdicio de deuda A2b: el generador deriva prefijos de hasta
 * 29 chars (nombre de categoría limpio), pero la columna era VARCHAR(8); MySQL
 * truncaba silenciosamente los prefijos largos y colapsaba decenas de categorías
 * distintas en el mismo valor (p.ej. 31 categorías "Accesorios*" → "ACCESORI").
 * Con 30 chars ningún prefijo se trunca y el SKU resultante cabe en VARCHAR(50).
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

async function main() {
  // MySQL: MODIFY COLUMN redefinelt el ancho sin pérdida de datos (ensanchamiento).
  await prisma.$executeRawUnsafe(
    `ALTER TABLE categorias MODIFY COLUMN Prefijo_SKU VARCHAR(30) NOT NULL DEFAULT 'GEN'`,
  );
  const [rows]: any = await prisma.$queryRawUnsafe(
    `SELECT CHARACTER_MAXIMUM_LENGTH AS maxlen FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_NAME='categorias' AND COLUMN_NAME='Prefijo_SKU'`,
  );
  console.log('Prefijo_SKU ancho ahora:', rows?.[0]?.maxlen, '(esperado 30)');
}
main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
