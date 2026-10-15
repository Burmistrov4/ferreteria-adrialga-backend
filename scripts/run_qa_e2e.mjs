#!/usr/bin/env node
/**
 * run_qa_e2e.mjs — Corredor E2E de QA para Adrialga (Ciclo 2).
 *
 * SEGURIDAD (ADR-002 / ADR-007): deriva la URL de QA desde `.env` cambiando
 * solo el nombre de la base a `adrialga_qa`. NUNCA usa la base real. No imprime
 * credenciales (solo host y nombre de base).
 *
 * Ejecuta, en orden, los scripts de prueba que escriben/leen contra la base de
 * QA desechable y reporta un resumen con códigos de salida por prueba.
 *
 * Uso:
 *   node scripts/run_qa_e2e.mjs
 *
 * Requisitos: `adrialga_qa` debe existir (ver scripts/setup_qa_db.cjs) y el
 * esquema debe estar empujado con `prisma db push` contra esa base.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import guard from './qa_guard.cjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

// ── Derivar URL de QA desde .env (sin imprimir credenciales) ────────────────
function leerEnv() {
  const envPath = path.join(root, '.env');
  const m = {};
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) m[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  return m;
}

const env = leerEnv();
const realUrl = env['DATABASE_URL'] || '';
if (!realUrl) {
  console.error('ABORTADO: DATABASE_URL no está definida en .env');
  process.exit(3);
}
// Salvaguarda: la real debe ser local y su base no ser ya adrialga_qa;
// solo entonces se deriva la base de QA desechable. Sin credenciales en pantalla.
const vLocal = guard.validarLocal(realUrl);
if (!vLocal.ok) {
  console.error(`ABORTADO: ${vLocal.error}`);
  process.exit(vLocal.code || 3);
}
const d = guard.derivarUrlQa(realUrl);
if (!d.ok) {
  console.error(`ABORTADO: ${d.error}`);
  process.exit(d.code || 3);
}
const qaUrl = d.qaUrl;
console.log(`QA ${guard.sanitizar(qaUrl)} (sin credenciales en pantalla)`);

const TESTS = [
  { id: 'CORS-VAL', file: 'test_cors_validator.ts', area: 'Seguridad/API WS' },
  { id: 'A-016', file: 'test_variantes_compra.ts', area: 'Compras/variantes' },
  { id: 'A-017', file: 'test_reversa_compra.ts', area: 'Compras/reversa' },
  { id: 'CMP', file: 'test_cmp_compras.ts', area: 'CMP/ Inventario' },
  { id: 'CASH-CONC', file: 'test_caja_concurrencia.ts', area: 'Caja/concurrencia' },
  { id: 'CASH-REC', file: 'test_conciliacion_caja.ts', area: 'Caja/arqueo' },
  { id: 'A-018/19', file: 'test_dashboard_metricas.ts', area: 'Dashboard/BI' },
];

const logDir = path.join(root, 'qa_e2e_logs');
fs.mkdirSync(logDir, { recursive: true });

function ejecutar(test) {
  return new Promise((resolve) => {
    const logPath = path.join(logDir, `${test.file.replace(/\.ts$/, '')}.log`);
    const out = fs.openSync(logPath, 'w');
    const cmd = `npx --no-install ts-node --transpile-only scripts/${test.file}`;
    const child = spawn(cmd, {
      cwd: root,
      shell: true,
      env: { ...process.env, DATABASE_URL_QA: qaUrl },
      stdio: ['ignore', out, out],
    });
    child.on('close', (code) => {
      fs.closeSync(out);
      resolve(code ?? 1);
    });
    child.on('error', () => {
      fs.closeSync(out);
      resolve(1);
    });
  });
}

const resultados = [];
for (const t of TESTS) {
  process.stdout.write(`→ ${t.id.padEnd(10)} ${t.area.padEnd(22)} ${t.file} ... `);
  const code = await ejecutar(t);
  const ok = code === 0;
  console.log(ok ? 'PASS (exit 0)' : `FAIL (exit ${code}) → logs/${t.file.replace(/\.ts$/, '')}.log`);
  resultados.push({ ...t, code, ok });
}

console.log('\n==== RESUMEN E2E QA (adrialga_qa) ====');
console.log('ID         ÁREA                    ARCHIVO                       ESTADO');
for (const r of resultados) {
  console.log(
    `${r.id.padEnd(10)} ${r.area.padEnd(22)} ${r.file.padEnd(28)} ${r.ok ? 'PASS' : 'FAIL'}`,
  );
}
const pass = resultados.filter((r) => r.ok).length;
console.log(`\nPASS=${pass}/${resultados.length}  FAIL=${resultados.length - pass}`);
const fallaron = resultados.filter((r) => !r.ok).map((r) => r.file);
if (fallaron.length) {
  console.error(`Fallaron: ${fallaron.join(', ')}`);
  process.exitCode = 1;
}
