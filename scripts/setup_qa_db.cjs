/**
 * setup_qa_db.cjs — prepara una base de QA DESECHABLE para las pruebas de
 * concurrencia. NO toca la base de producción/local real: crea una base
 * aparte (adrialga_qa) en el MISMO servidor declarado en DATABASE_URL.
 *
 * Uso: node scripts/setup_qa_db.cjs [ruta_salida_qa_url]
 *  - Lee DATABASE_URL desde .env (sin imprimir credenciales).
 *  - Cambia el nombre de la base a adrialga_qa.
 *  - CREATE DATABASE IF NOT EXISTS adrialga_qa (idempotente).
 *  - Ejecuta `prisma db push` contra la base QA (esquema desde schema.prisma).
 *  - Opcional: escribe la URL QA a un archivo (para que el test la consuma).
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const guard = require('./qa_guard.cjs');

const root = path.resolve(__dirname, '..');
const envPath = path.join(root, '.env');

if (!fs.existsSync(envPath)) {
  console.error('No se encontró .env en el backend. Abortando.');
  process.exit(3);
}
const envRaw = fs.readFileSync(envPath, 'utf8');
const m = envRaw.match(/^\s*DATABASE_URL\s*=\s*(\S+)\s*$/m);
if (!m) {
  console.error('DATABASE_URL no está definida en .env. Abortando.');
  process.exit(3);
}
const realUrl = m[1].replace(/^['"]|['"]$/g, '');

// Validación de seguridad (ADR-002/007): rechazar si no es local/loopback y si
// la base real ya es adrialga_qa. Nunca se crea una base QA remota.
const vLocal = guard.validarLocal(realUrl);
if (!vLocal.ok) {
  console.error('ABORTADO:', vLocal.error);
  process.exit(vLocal.code || 3);
}
const d = guard.derivarUrlQa(realUrl);
if (!d.ok) {
  console.error('ABORTADO:', d.error);
  process.exit(d.code || 3);
}
const qaUrl = d.qaUrl;

(async () => {
  // 1) Crear la base si no existe (idempotente, solo metadata, sin tablas).
  const { PrismaClient } = require(path.join(root, 'node_modules', '@prisma', 'client'));
  const admin = new PrismaClient({ datasources: { db: { url: realUrl } } });
  try {
    await admin.$executeRawUnsafe('CREATE DATABASE IF NOT EXISTS `adrialga_qa`');
    console.log('OK: base adrialga_qa asegurada (CREATE DATABASE IF NOT EXISTS).');
  } catch (e) {
    console.error('Fallo al crear adrialga_qa:', e.message);
    process.exit(1);
  } finally {
    await admin.$disconnect();
  }

  // 2) Empujar el esquema a la base QA (nueva y vacía => sin data loss real).
  try {
    execFileSync('npx', ['--no-install', 'prisma', 'db', 'push', '--skip-generate', '--accept-data-loss'], {
      cwd: root,
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: qaUrl },
    });
    console.log('OK: esquema empujado a adrialga_qa.');
  } catch (e) {
    console.error('Fallo al empujar esquema a QA:', e.message);
    process.exit(1);
  }

  // 3) Opcional: volcar la URL QA a un archivo para el test.
  const out = process.argv[2];
  if (out) {
    fs.writeFileSync(out, qaUrl, 'utf8');
    console.log('OK: URL QA escrita a', out);
  }
})();
