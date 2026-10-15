'use strict';
/**
 * safe_migrate_deploy.cjs — Compuerta de seguridad para `prisma migrate deploy`
 * (comando `npm run db:deploy`).
 *
 * ADR-002/007:
 *  - Ausente/malformada o protocolo no permitido → ABORTO SIEMPRE (sin escape).
 *  - Host no-loopback → aborto por defecto; solo un despliegue remoto deliberado
 *    se permite definiendo explícitamente ALLOW_REMOTE_DEPLOY=1. La variable NO
 *    salta ninguna otra validación.
 * Nunca imprime credenciales.
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const guard = require('./qa_guard.cjs');

const url = process.env.DATABASE_URL ?? '';
const u = guard.parsear(url);
if (!u) {
  console.error('ABORTADO: DATABASE_URL ausente o malformada (sin escape posible).');
  process.exit(3);
}
if (!guard.ALLOWED_PROTOCOLS.includes((u.protocol || '').toLowerCase())) {
  console.error(`ABORTADO: protocolo no permitido (${u.protocol}); no se ejecuta migrate deploy.`);
  process.exit(3);
}
const remoto = !guard.LOOPBACK_CANON[guard.extraerHost(u)];
if (remoto && !process.env.ALLOW_REMOTE_DEPLOY) {
  console.error(
    `ABORTADO: prisma migrate deploy solo corre por defecto contra loopback (${guard.sanitizar(url)}): host no loopback`,
  );
  console.error('Si estás desplegando a producción a propósito, define ALLOW_REMOTE_DEPLOY=1.');
  process.exit(3);
}
if (remoto) {
  console.warn('⚠ ALLOW_REMOTE_DEPLOY=1: migrate deploy sobre destino remoto. Verificado manualmente.');
}

try {
  const { execFileSync } = require('child_process');
  execFileSync('npx', ['--no-install', 'prisma', 'migrate', 'deploy'], {
    cwd: path.join(__dirname, '..'),
    stdio: 'inherit',
  });
} catch (e) {
  const limpio = (String(e.stdout || '') + String(e.stderr || '') + String(e.message || ''))
    .split('mysql://').join('mysql://***@');
  console.error('migrate deploy falló:\n' + limpio);
  process.exit(1);
}
