/**
 * _audit_probe_monitor.cjs — sonda de auditoría (temporal, no toca la BD).
 *
 * Firma un JWT local con el JWT_SECRET del .env y llama a /api/monitor/esquema
 * en ambos modos para comprobar la forma de la respuesta. Nunca imprime el
 * secreto ni credenciales: solo cuenta tablas/relaciones y muestra el modo.
 */
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

const root = path.resolve(__dirname, '..');
const env = {};
for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
  const i = line.indexOf('=');
  if (i > 0) env[line.slice(0, i).trim()] = line.slice(i + 1).trim();
}
if (!env.JWT_SECRET) {
  console.error('ABORT: JWT_SECRET ausente en .env');
  process.exit(2);
}
const token = jwt.sign(
  { Usuario_ID: 1, Nombre: 'Auditor', Rol: 'Administrador' },
  env.JWT_SECRET,
  { expiresIn: '5m' }
);

const base = 'http://127.0.0.1:3000/api/monitor/esquema';
(async () => {
  for (const modo of ['presentacion', 'full']) {
    const r = await fetch(`${base}?modo=${modo}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const j = await r.json().catch(() => null);
    console.log(
      `${modo.padEnd(12)} http=${r.status} tablas=${j?.tablas?.length ?? '?'} ` +
        `relaciones=${j?.relaciones?.length ?? '?'} base=${j?.base ?? '?'}`
    );
  }
})();
