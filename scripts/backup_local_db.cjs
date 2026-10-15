/**
 * Backup pre-migración, solo de la base local adrialga.
 * Nunca imprime credenciales ni acepta destinos remotos/otra base.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysqldump = require('mysqldump');

(async () => {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL no configurada.');
  const url = new URL(raw);
  const dbName = url.pathname.replace(/^\//, '').split('?')[0];
  if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname) || dbName !== 'adrialga') {
    throw new Error('ABORTADO: el backup exige MySQL local y base adrialga.');
  }
  const outDir = path.resolve(__dirname, '..', 'backups');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `adrialga_pre_lan_migration_${stamp}.sql`);
  await mysqldump({
    connection: {
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: dbName,
    },
    dumpToFile: outFile,
  });
  const stat = fs.statSync(outFile);
  if (stat.size < 1000) throw new Error('Backup demasiado pequeño; no se considera válido.');
  const sample = fs.readFileSync(outFile, 'utf8').slice(0, 50000);
  if (!/CREATE TABLE/i.test(sample)) throw new Error('El archivo no parece contener estructura SQL.');
  console.log('BACKUP_STATUS=PASS');
  console.log('DB_HOST=' + url.hostname + ' DB_NAME=' + dbName);
  console.log('BACKUP_FILE=' + outFile);
  console.log('BACKUP_BYTES=' + stat.size);
})().catch((e) => {
  console.error('BACKUP_STATUS=FAIL: ' + (e?.message ?? e));
  process.exitCode = 1;
});
