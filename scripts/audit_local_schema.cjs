/**
 * Auditoría de solo lectura de columnas críticas de la BD local.
 * Aborta si DATABASE_URL no apunta a localhost/127.0.0.1 y a la base adrialga.
 * No imprime credenciales ni filas comerciales y no modifica el esquema.
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const guard = require('./qa_guard.cjs');

const url = new URL(process.env.DATABASE_URL || '');
const dbName = url.pathname.replace(/^\//, '').split('?')[0];
const _vHost = guard.validarHostLocal(process.env.DATABASE_URL || '');
if (!_vHost.ok || dbName !== 'adrialga') {
  throw new Error(`Abortado: se esperaba MySQL local y base adrialga (${guard.sanitizar(process.env.DATABASE_URL || '')}); no se consultó ninguna base.`);
}

const prisma = new PrismaClient();

(async () => {
  try {
    const rows = await prisma.$queryRaw`
      SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ${dbName}
    `;
    const found = new Set(rows.map((r) => `${r.tableName}.${r.columnName}`));
    const checks = [
      'detalle_notas_entrega.Variante_ID',
      'notas_entrega_entrada.Anulada_Por',
      'notas_entrega_entrada.Fecha_Anulacion',
      'notas_entrega_entrada.Motivo_Anulacion',
      'producto_variantes.Margen_Ganancia',
      'facturas.Tipo_Documento',
      'facturas.Tasa_Cambio',
      'usuarios.Activo',
    ];
    console.log('DB_HOST=' + url.hostname + ' DB_NAME=' + dbName + ' MODE=READ_ONLY');
    for (const c of checks) console.log(c + '=' + (found.has(c) ? 'PRESENT' : 'MISSING'));
    console.log('SCHEMA_AUDIT_DONE');
  } catch (e) {
    console.error('SCHEMA_AUDIT_FAIL=' + (e?.message ?? e));
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
