#!/usr/bin/env node
/**
 * test_realtime_sync.cjs — Prueba Fase D: sincronización en tiempo real (Ciclo 3).
 *
 * Cubre el ciclo completo que pide el megaprompt:
 *   acción -> validación HTTP -> transacción -> evento `db_update` -> clientes
 *   autenticados -> (desconexión/reconexión) re-fetch recupera el estado.
 *
 * Aserciones:
 *   A1  socket SIN token   -> rechazado (connect_error)
 *   A2  socket token inválido -> rechazado
 *   A3  dos clientes (ADMIN + CAJERO) con JWT válido conectan OK
 *   A4  "A crea, B recibe": POST /api/proveedores (ADMIN) -> ambos reciben
 *        db_update modulo 'proveedores' (broadcast global, sin salas por rol)
 *   A5  Aislamiento por rol en API: POST /api/notas/1/reversar con CAJERO -> 403
 *   A6  Reconexión: B se desconecta, ADMIN crea otro proveedor (B lo pierde),
 *        B se reconecta y vía GET /api/proveedores recupera AMBOS (re-fetch).
 *
 * SEGURIDAD: corre SOLO contra `adrialga_qa`. Deriva DATABASE_URL_QA desde .env
 * (no imprime credenciales). Limpia los proveedores de prueba que crea.
 * Uso: node scripts/test_realtime_sync.cjs
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const jwt = require('jsonwebtoken');

const root = path.resolve(__dirname, '..');
const PORT = 3997;
const BASE = `http://localhost:${PORT}`;

// ── .env -> QA (sin imprimir credenciales) ──────────────────────────────────
function leerEnv() {
  const out = {};
  const p = path.join(root, '.env');
  if (fs.existsSync(p)) {
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
  }
  return out;
}
const env = leerEnv();
const JWT_SECRET = env.JWT_SECRET;
const guard = require('./qa_guard.cjs');
const realUrl = env.DATABASE_URL;
if (!JWT_SECRET || !realUrl) {
  console.error('ABORTADO: faltan JWT_SECRET o DATABASE_URL en .env');
  process.exit(3);
}
const _vReal = guard.validarLocal(realUrl);
if (!_vReal.ok) {
  console.error(`ABORTADO: DATABASE_URL real no es local válida (${guard.sanitizar(realUrl)}): ${_vReal.error}`);
  process.exit(3);
}
const _d = guard.derivarUrlQa(realUrl);
if (!_d.ok) { console.error(`ABORTADO: no se pudo derivar QA: ${_d.error}`); process.exit(3); }
const qaUrl = _d.qaUrl;
console.log(`QA host: ${new URL(qaUrl).host} · base: adrialga_qa (sin credenciales en pantalla)`);

// ── Boot del servidor QA en :3997 ───────────────────────────────────────────
const envHijo = {
  ...process.env,
  NODE_ENV: 'development',
  JWT_SECRET,
  PORT: String(PORT),
  DATABASE_URL: qaUrl,
};
const hijo = spawn('node', ['dist/index.js'], { cwd: root, env: envHijo, stdio: 'inherit' });
const cleanup = () => { try { hijo.kill(); } catch {} };
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function httpReq(method, ruta, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      hostname: 'localhost', port: PORT, path: ruta, method,
      headers: {
        'Content-Type': 'application/json',
        Origin: `http://localhost:${PORT}`,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => resolve({ status: res.statusCode, raw }));
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(new Error('timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

async function waitForHealth(maxMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    try {
      const r = await httpReq('GET', '/api/health');
      if (r.status === 200 && r.raw.includes('connected')) return true;
    } catch {}
    await sleep(500);
  }
  return false;
}

function firma(rol) {
  return jwt.sign(
    { Usuario_ID: 1, Nombre: `QA-${rol}`, Rol: rol },
    JWT_SECRET,
    { expiresIn: '2h' },
  );
}

function newSocket(token, etiqueta, results) {
  // eslint-disable-next-line global-require
  const { io } = require('socket.io-client');
  const s = io(BASE, {
    auth: { token },
    transports: ['websocket'],
    reconnection: false,
    timeout: 6000,
  });
  s._recibidos = [];
  s.on('db_update', (p) => {
    s._recibidos.push(p && p.modulo ? String(p.modulo) : '');
    results.push(`${etiqueta}: db_update[${p && p.modulo ? p.modulo : '?'}]`);
  });
  return s;
}

function waitConnect(sock) {
  return new Promise((resolve) => {
    const to = setTimeout(() => resolve({ ok: false, err: 'timeout conectando' }), 8000);
    sock.on('connect_error', (e) => { clearTimeout(to); resolve({ ok: false, err: String(e && e.message || e) }); });
    sock.on('connect', () => { clearTimeout(to); resolve({ ok: true }); });
  });
}

async function main() {
  let failures = 0;
  let passes = 0;
  const results = [];
  const assert = (ok, label) => {
    if (ok) { passes++; results.push(`PASS  ${label}`); }
    else { failures++; results.push(`FAIL  ${label}`); }
  };

  // Health
  const up = await waitForHealth();
  assert(up, 'health 200 + database connected');
  if (!up) { results.push('servidor QA no respondió; abortando'); fin(failures, passes, results); return; }

  // Health incluye timestamp/latencia
  const h = await httpReq('GET', '/api/health');
  const hj = JSON.parse(h.raw);
  assert(hj.status === 'ok' && typeof hj.timestamp === 'string', 'health tiene status=ok y timestamp');

  const tokenAdmin = firma('ADMIN');
  const tokenCajero = firma('CAJERO');

  // A1: sin token
  const sNoTok = newSocket('', 'sin-token', results);
  const noTokRes = await waitConnect(sNoTok);
  assert(!noTokRes.ok, 'A1 socket SIN token rechazado | ' + (noTokRes.err || ''));

  // A2: token inválido
  const sBadTok = newSocket('token.invalido.abc', 'token-invalido', results);
  const badRes = await waitConnect(sBadTok);
  assert(!badRes.ok, 'A2 socket token INVÁLIDO rechazado | ' + (badRes.err || ''));

  // A3: dos clientes (ADMIN y CAJERO)
  const sA = newSocket(tokenAdmin, 'A(ADMIN)', results);
  const sB = newSocket(tokenCajero, 'B(CAJERO)', results);
  const [cA, cB] = await Promise.all([waitConnect(sA), waitConnect(sB)]);
  assert(cA.ok, 'A3 cliente A (ADMIN) conecta | ' + (cA.err || 'ok'));
  assert(cB.ok, 'A3 cliente B (CAJERO) conecta | ' + (cB.err || 'ok'));

  const rif1 = `V${Date.now().toString().slice(-9)}A`;
  const rif2 = `V${Date.now().toString().slice(-9)}B`;
  const createdProvs = [];

  try {
    // A4: A crea -> B recibe (broadcast global)
    sA._recibidos = []; sB._recibidos = []; results.length = 0;
    const cre1 = await httpReq('POST', '/api/proveedores', {
      token: tokenAdmin,
      body: { RIF_Cedula: rif1, Razon_Social: 'QA_SYNC_TEST_UNO' },
    });
    assert(cre1.status === 201, 'A4 POST /api/proveedores -> 201 (recibió ' + cre1.status + ')');
    try { const j = JSON.parse(cre1.raw); createdProvs.push(j.Proveedor_ID); } catch {}
    await sleep(1200);
    assert(sB._recibidos.includes('proveedores'), 'A4 B (CAJERO) recibió db_update[proveedores] tras creación de A | recibidos=' + JSON.stringify(sB._recibidos));
    assert(sA._recibidos.includes('proveedores'), 'A4 A (emisor) también recibió el broadcast (broadcast global) | recibidos=' + JSON.stringify(sA._recibidos));

    // A5: aislamiento por rol en la API (CAJERO no puede reversar notas)
    const rev = await httpReq('POST', '/api/notas/1/reversar', { token: tokenCajero, body: { Motivo: 'QA' } });
    assert(rev.status === 403, 'A5 CAJERO en /api/notas/1/reversar -> 403 PERMISO_INSUFICIENTE (recibió ' + rev.status + ')');

    // A6: desconexión/reconexión — B se desconecta, A crea otro proveedor (B lo pierde), B reconecta y re-fetchea
    sB.disconnect();
    await sleep(400);
    sB._recibidos.length = 0; // solo interesan los eventos recibidos MIENTRAS está desconectado
    const cre2 = await httpReq('POST', '/api/proveedores', {
      token: tokenAdmin,
      body: { RIF_Cedula: rif2, Razon_Social: 'QA_SYNC_TEST_DOS' },
    });
    assert(cre2.status === 201, 'A6 creación #2 (A) mientras B está desconectado -> 201 (recibió ' + cre2.status + ')');
    try { const j = JSON.parse(cre2.raw); createdProvs.push(j.Proveedor_ID); } catch {}
    await sleep(1200);
    assert(sB._recibidos.length === 0, 'A6 B desconectado NO recibió el evento que se emitió offline | recibidos=' + JSON.stringify(sB._recibidos));

    // B se reconecta
    const sB2 = newSocket(tokenCajero, 'B(reconectado)', results);
    const recB = await waitConnect(sB2);
    assert(recB.ok, 'A6 B se reconecta tras caída | ' + (recB.err || 'ok'));

    // Recuperación por re-fetch (así opera el cliente Flutter en onReconnect)
    const list = await httpReq('GET', '/api/proveedores', { token: tokenCajero });
    const arr = JSON.parse(list.raw);
    const found1 = Array.isArray(arr) && arr.some((p) => p && p.Razon_Social === 'QA_SYNC_TEST_UNO');
    const found2 = Array.isArray(arr) && arr.some((p) => p && p.Razon_Social === 'QA_SYNC_TEST_DOS');
    assert(found1 && found2, 'A6 tras reconexión, B recupera AMBOS proveedores vía GET (modo re-fetch Flutter) | uno=' + found1 + ' dos=' + found2);
    sB2.close();
  } finally {
    // Limpieza de fixtures proveedores (deja QA sin residuos)
    for (const id of createdProvs) {
      try { await httpReq('DELETE', `/api/proveedores/${id}`, { token: tokenAdmin }); } catch {}
    }
    sA.close(); sB.close();
  }

  fin(failures, passes, results);
}

function fin(failures, passes, results) {
  console.log('');
  console.log('=== RESUMEN FASE D: sincronización en tiempo real (QA) ===');
  for (const r of results) console.log('  ' + r);
  console.log(`RESULTADO: PASS=${passes} FAIL=${failures}`);
  console.log(failures === 0 ? 'EXITO: sincronización tiempo real validada (auth + broadcast + rol API + reconexión).' : 'FALLO: revisa arriba.');
  cleanup();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('ERROR inesperado:', e); cleanup(); process.exit(1); });
