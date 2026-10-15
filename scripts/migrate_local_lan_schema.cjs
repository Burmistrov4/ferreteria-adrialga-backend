/**
 * Migración aditiva de esquema para que la BD local coincida con el Prisma actual.
 * Ejecutar solo después de backup_local_db.cjs y pasando LOCAL_DB_BACKUP_PATH.
 * Aborta si la URL no es localhost/127.0.0.1 y DB adrialga.
 * No borra ni reescribe filas existentes.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const url = new URL(process.env.DATABASE_URL || '');
const dbName = url.pathname.replace(/^\//, '').split('?')[0];
const backup = process.env.LOCAL_DB_BACKUP_PATH;
if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname) || dbName !== 'adrialga') {
  throw new Error('ABORTADO: migración permitida solo en MySQL local / adrialga.');
}
if (!backup || !fs.existsSync(backup) || fs.statSync(backup).size < 1000) {
  throw new Error('ABORTADO: LOCAL_DB_BACKUP_PATH no apunta a un backup verificado.');
}

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

(async () => {
  try {
    const columns = await prisma.$queryRaw`
      SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName
      FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ${dbName}
    `;
    const found = new Set(columns.map((r) => `${r.tableName}.${r.columnName}`));
    const constraints = await prisma.$queryRaw`
      SELECT CONSTRAINT_NAME AS constraintName
      FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = ${dbName}
        AND TABLE_NAME = 'detalle_notas_entrega'
        AND CONSTRAINT_TYPE = 'FOREIGN KEY'
    `;
    const fks = new Set(constraints.map((r) => r.constraintName));
    const tables = new Set(columns.map((r) => r.tableName));
    for (const t of ['detalle_notas_entrega', 'notas_entrega_entrada', 'producto_variantes']) {
      if (!tables.has(t)) throw new Error('Falta tabla requerida: ' + t + '. No se aplicó migración.');
    }

    const addColumn = async (table, column, sql) => {
      if (!found.has(table + '.' + column)) {
        await prisma.$executeRawUnsafe(sql);
        console.log('ADDED_COLUMN=' + table + '.' + column);
      } else {
        console.log('EXISTS_COLUMN=' + table + '.' + column);
      }
    };

    await addColumn('detalle_notas_entrega', 'Variante_ID',
      'ALTER TABLE `detalle_notas_entrega` ADD COLUMN `Variante_ID` INT NULL');
    if (!found.has('detalle_notas_entrega.Variante_ID')) {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE `detalle_notas_entrega` ADD INDEX `IDX_DetalleNotas_Variante` (`Variante_ID`)'
      );
    } else {
      const idx = await prisma.$queryRaw`
        SELECT INDEX_NAME AS indexName FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = ${dbName} AND TABLE_NAME = 'detalle_notas_entrega'
          AND INDEX_NAME = 'IDX_DetalleNotas_Variante'
      `;
      if (idx.length === 0) {
        await prisma.$executeRawUnsafe(
          'ALTER TABLE `detalle_notas_entrega` ADD INDEX `IDX_DetalleNotas_Variante` (`Variante_ID`)'
        );
      }
    }
    if (!fks.has('FK_DetalleNota_Variante')) {
      await prisma.$executeRawUnsafe(
        'ALTER TABLE `detalle_notas_entrega` ADD CONSTRAINT `FK_DetalleNota_Variante` ' +
        'FOREIGN KEY (`Variante_ID`) REFERENCES `producto_variantes` (`Variante_ID`) ' +
        'ON DELETE SET NULL ON UPDATE CASCADE'
      );
      console.log('ADDED_FK=FK_DetalleNota_Variante');
    } else {
      console.log('EXISTS_FK=FK_DetalleNota_Variante');
    }

    await addColumn('notas_entrega_entrada', 'Anulada_Por',
      'ALTER TABLE `notas_entrega_entrada` ADD COLUMN `Anulada_Por` INT NULL');
    await addColumn('notas_entrega_entrada', 'Fecha_Anulacion',
      'ALTER TABLE `notas_entrega_entrada` ADD COLUMN `Fecha_Anulacion` TIMESTAMP NULL');
    await addColumn('notas_entrega_entrada', 'Motivo_Anulacion',
      'ALTER TABLE `notas_entrega_entrada` ADD COLUMN `Motivo_Anulacion` VARCHAR(200) NULL');

    const verify = await prisma.$queryRaw`
      SELECT TABLE_NAME AS tableName, COLUMN_NAME AS columnName
      FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = ${dbName}
        AND ((TABLE_NAME = 'detalle_notas_entrega' AND COLUMN_NAME = 'Variante_ID')
          OR (TABLE_NAME = 'notas_entrega_entrada' AND COLUMN_NAME IN ('Anulada_Por','Fecha_Anulacion','Motivo_Anulacion')))
    `;
    if (verify.length !== 4) throw new Error('Verificación incompleta: se esperaban 4 columnas y hay ' + verify.length);
    console.log('LOCAL_SCHEMA_MIGRATION=PASS');
    console.log('BACKUP_VERIFIED=' + path.basename(backup));
    console.log('COLUMNS_VERIFIED=' + verify.length);
  } catch (e) {
    console.error('LOCAL_SCHEMA_MIGRATION=FAIL: ' + (e?.message ?? e));
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
})();
