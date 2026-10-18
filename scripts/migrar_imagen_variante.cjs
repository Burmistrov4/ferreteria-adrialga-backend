#!/usr/bin/env node
/** Agrega producto_variantes.Imagen_URL si no existe (idempotente). */
const path = require('node:path');
const fs = require('node:fs');
const { PrismaClient } = require('@prisma/client');

function leerAiven() {
  const p = path.resolve(__dirname, '..', '.env.aiven.local');
  if (!fs.existsSync(p)) return null;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const i = line.indexOf('=');
    if (i > 0 && line.slice(0, i).trim() === 'AIVEN_DATABASE_URL') {
      const v = line.slice(i + 1).trim();
      if (!v) return null;
      try {
        const u = new URL(v);
        if (!u.pathname || u.pathname === '/' || u.pathname === '/defaultdb') u.pathname = '/adrialga';
        return u.toString();
      } catch { return v; }
    }
  }
  return null;
}

const url = leerAiven();
const prisma = new PrismaClient(url ? { datasourceUrl: url } : undefined);

(async () => {
  console.log(url ? 'Entorno: AIVEN (produccion)' : 'Entorno: BD local (.env)');
  const antes = await prisma.$queryRawUnsafe(
    "SHOW COLUMNS FROM producto_variantes LIKE 'Imagen_URL'",
  );
  if (Array.isArray(antes) && antes.length > 0) {
    console.log('La columna Imagen_URL ya existe.');
  } else {
    await prisma.$executeRawUnsafe(
      'ALTER TABLE producto_variantes ADD COLUMN Imagen_URL VARCHAR(500) NULL',
    );
    console.log('Columna Imagen_URL agregada.');
  }
  const despues = await prisma.$queryRawUnsafe(
    "SHOW COLUMNS FROM producto_variantes LIKE 'Imagen_URL'",
  );
  console.log('Verificacion:', JSON.stringify(despues));
  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('ERROR:', e.message);
  try { await prisma.$disconnect(); } catch {}
  process.exitCode = 1;
});
