// Empuja el esquema Prisma a la base QA aislada (adrialga_qa).
// SOLO QA: deriva la URL desde DATABASE_URL reemplazando el nombre de base,
// jamas imprime credenciales. Uso: node scripts/push_qa.js
require('dotenv').config();
const { execSync } = require('child_process');

const guard = require('./qa_guard.cjs');
const real = process.env.DATABASE_URL;
if (!real) { console.error('Falta DATABASE_URL en .env'); process.exit(1); }
const _vReal = guard.validarLocal(real);
if (!_vReal.ok) { console.error(`ABORTADO: DATABASE_URL real no es local válida (${guard.sanitizar(real)}): ${_vReal.error}`); process.exit(3); }
const _d = guard.derivarUrlQa(real);
if (!_d.ok) { console.error(`ABORTADO: no se pudo derivar QA: ${_d.error}`); process.exit(3); }
const u = new URL(_d.qaUrl);

try {
  const out = execSync('npx prisma db push --skip-generate', {
    env: { ...process.env, DATABASE_URL: u.toString() },
    encoding: 'utf8',
  });
  // Redactar URLs para no filtrar credenciales a logs (regla del proyecto).
  const limpio = out.split('mysql://').join('mysql://***@');
  console.log(limpio);
} catch (e) {
  const limpio = (String(e.stdout || '') + String(e.stderr || '') + String(e.message || ''))
    .split('mysql://').join('mysql://***@');
  console.error('PUSH FALLO:\n' + limpio);
  process.exit(1);
}
