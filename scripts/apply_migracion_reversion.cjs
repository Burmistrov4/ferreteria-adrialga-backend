// scripts/apply_migracion_reversion.cjs
// Aplica la migración de Reversión de Venta (P0.4) a la BD local sin depender
// del CLI de Prisma (usa $executeRawUnsafe + @prisma/client). IDEMPOTENTE:
// las columnas/índices ya existentes se omiten como "SKIP".
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');
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

const SENTENCIAS = [
  "ALTER TABLE facturas ADD COLUMN Tipo_Documento VARCHAR(20) NULL AFTER Estatus;",
  "ALTER TABLE facturas ADD COLUMN Factura_Afectada_ID INT NULL AFTER Tipo_Documento;",
  "ALTER TABLE facturas ADD INDEX IDX_Facturas_TipoDoc (Tipo_Documento);",
  "ALTER TABLE facturas ADD INDEX IDX_Facturas_Afectada (Factura_Afectada_ID);",
  "UPDATE facturas SET Tipo_Documento='FACTURA' WHERE Tipo_Documento IS NULL;",
  "INSERT INTO contadores_fiscales (Clave, Valor) VALUES ('CTRL-NC-2026', 0) ON DUPLICATE KEY UPDATE Clave=Clave;",
];

async function main() {
  for (const s of SENTENCIAS) {
    const etiqueta = s.split(' ').slice(0, 3).join(' ');
    try {
      await prisma.$executeRawUnsafe(s);
      console.log(`OK    ${etiqueta}`);
    } catch (e) {
      const msg = String(e?.message || e);
      if (/Duplicate|already exists|already used/i.test(msg)) {
        console.log(`SKIP  ${etiqueta} (ya aplicado)`);
      } else {
        throw e;
      }
    }
  }
  console.log('Migración Reversión de Venta aplicada/verificada en BD local.');
}

main()
  .catch((e) => {
    console.error('FALLO:', e?.message || e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());