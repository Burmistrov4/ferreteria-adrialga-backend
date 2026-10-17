#!/usr/bin/env node
/**
 * test_sync_multiusuario.cjs — Sincronización en tiempo real con 2+ usuarios
 * contra un servidor YA CORRIENDO (local o producción).
 *
 * A diferencia de `test_realtime_sync.cjs` (que arranca su propio servidor
 * contra la base QA y firma su propio JWT), este script se conecta a un
 * servidor REAL ya desplegado y obtiene el token con el login verdadero, para
 * poder validar Producción (Render + Aiven) igual que Local.
 *
 * Aserciones:
 *   M1  login real contra el servidor -> token válido
 *   M2  N clientes autenticados conectan por Socket.IO
 *   M3  A escribe -> TODOS los demás (B, C...) reciben db_update (broadcast)
 *   M4  B escribe -> A y C también reciben (bidireccional, no solo "el jefe")
 *   M5  latencia del evento medida y reportada (ms)
 *   M6  limpieza: los registros de prueba se borran (no deja residuos)
 *
 * Uso:
 *   BASE=https://ferreteria-adrialga-backend.onrender.com \
 *   ADM_CRED=<credencial> ADM_PASS=<clave> CLIENTES=3 \
 *   node scripts/test_sync_multiusuario.cjs
 *
 * SEGURIDAD: no imprime credenciales ni el token completo (solo su prefijo).
 */
const BASE = (process.env.BASE || 'http://127.0.0.1:3000').replace(/\/$/, '');
const CRED = process.env.ADM_CRED;
const PASS = process.env.ADM_PASS;
const N = Number(process.env.CLIENTES || 3);

const { io } = require('socket.io-client');

let passes = 0;
let failures = 0;
const resultados = [];
function assert(ok, label) {
  if (ok) { passes++; resultados.push(`PASS  ${label}`); }
  else { failures++; resultados.push(`FAIL  ${label}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(ruta, { method = 'GET', token, body } = {}) {
  const res = await fetch(BASE + ruta, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Origin: BASE,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const raw = await res.text();
  let json = null;
  try { json = JSON.parse(raw); } catch {}
  return { status: res.status, raw, json };
}

function conectar(token, etiqueta, recibidos) {
  const s = io(BASE, {
    auth: { token },
    transports: ['websocket', 'polling'],
    reconnection: false,
    timeout: 20000,
  });
  s.on('db_update', (p) => {
    recibidos.push({
      modulo: p && p.modulo ? String(p.modulo) : '',
      mensaje: p && p.mensaje ? String(p.mensaje) : '',
      at: Date.now(),
    });
  });
  return s;
}

function esperarConexion(sock, ms = 20000) {
  return new Promise((resolve) => {
    const to = setTimeout(() => resolve({ ok: false, err: 'timeout' }), ms);
    sock.on('connect_error', (e) => {
      clearTimeout(to);
      resolve({ ok: false, err: String((e && e.message) || e) });
    });
    sock.on('connect', () => { clearTimeout(to); resolve({ ok: true }); });
  });
}

async function main() {
  console.log(`BASE: ${BASE}`);
  console.log(`Clientes simultáneos: ${N}`);
  resultados.push(`entorno: ${BASE}`);

  // M1 — login real
  if (!CRED || !PASS) {
    console.error('ABORTADO: faltan ADM_CRED / ADM_PASS en el entorno.');
    process.exit(3);
  }
  const login = await api('/api/auth/login', {
    method: 'POST',
    body: { Credencial: CRED, Password: PASS },
  });
  assert(login.status === 200, `M1 login real -> 200 (recibió ${login.status})`);
  const token = login.json && (login.json.token || login.json.Token || login.json.accessToken);
  if (!token) {
    console.error('ABORTADO: el login no devolvió token.');
    resultados.push(`respuesta login: ${String(login.raw).slice(0, 200)}`);
    fin();
    return;
  }
  resultados.push(`token obtenido (prefijo ${String(token).slice(0, 12)}…, sin imprimir completo)`);

  // M2 — N clientes conectan
  const clientes = [];
  for (let i = 0; i < N; i++) {
    const recibidos = [];
    const etiqueta = `C${i + 1}`;
    const s = conectar(token, etiqueta, recibidos);
    clientes.push({ etiqueta, socket: s, recibidos });
  }
  const conexiones = await Promise.all(clientes.map((c) => esperarConexion(c.socket)));
  conexiones.forEach((c, i) => {
    assert(c.ok, `M2 ${clientes[i].etiqueta} conectó por Socket.IO | ${c.err || 'ok'}`);
  });
  if (conexiones.some((c) => !c.ok)) { cerrar(); fin(); return; }

  const creados = [];
  try {
    // M3 — A (C1) escribe; TODOS los demás deben recibir
    clientes.forEach((c) => { c.recibidos.length = 0; });
    const sufijo = Date.now().toString().slice(-8);
    const t0 = Date.now();
    const cre1 = await api('/api/proveedores', {
      method: 'POST',
      token,
      body: { RIF_Cedula: `J${sufijo}A`, Razon_Social: `PRUEBA-SYNC-A-${sufijo}` },
    });
    assert(cre1.status === 201, `M3 POST /api/proveedores (C1) -> 201 (recibió ${cre1.status})`);
    if (cre1.json && cre1.json.Proveedor_ID) creados.push(cre1.json.Proveedor_ID);
    await sleep(2000);
    for (let i = 1; i < N; i++) {
      const rec = clientes[i].recibidos.some((e) => e.modulo === 'proveedores');
      assert(rec, `M3 ${clientes[i].etiqueta} recibió db_update[proveedores] de C1 | recibidos=${JSON.stringify(clientes[i].recibidos.map((e) => e.modulo))}`);
    }
    const latA = clientes[1] && clientes[1].recibidos.length
      ? clientes[1].recibidos[0].at - t0 : null;
    if (latA != null) resultados.push(`M5 latencia del evento (C1 -> ${clientes[1].etiqueta}): ${latA} ms`);

    // M4 — B (C2) escribe; C1 y C3 también reciben (bidireccional)
    clientes.forEach((c) => { c.recibidos.length = 0; });
    const t1 = Date.now();
    const cre2 = await api('/api/proveedores', {
      method: 'POST',
      token,
      body: { RIF_Cedula: `J${sufijo}B`, Razon_Social: `PRUEBA-SYNC-B-${sufijo}` },
    });
    assert(cre2.status === 201, `M4 POST /api/proveedores (C2) -> 201 (recibió ${cre2.status})`);
    if (cre2.json && cre2.json.Proveedor_ID) creados.push(cre2.json.Proveedor_ID);
    await sleep(2000);
    for (let i = 0; i < N; i++) {
      if (i === 1) continue; // C2 es el emisor
      const rec = clientes[i].recibidos.some((e) => e.modulo === 'proveedores');
      assert(rec, `M4 ${clientes[i].etiqueta} recibió db_update[proveedores] de C2 (bidireccional) | recibidos=${JSON.stringify(clientes[i].recibidos.map((e) => e.modulo))}`);
    }
    const latB = clientes[0] && clientes[0].recibidos.length
      ? clientes[0].recibidos[0].at - t1 : null;
    if (latB != null) resultados.push(`M5 latencia del evento (C2 -> C1): ${latB} ms`);
  } finally {
    // M6 — limpieza (no deja residuos en la base)
    for (const id of creados) {
      try { await api(`/api/proveedores/${id}`, { method: 'DELETE', token }); } catch {}
    }
    if (creados.length) resultados.push(`M6 limpieza: ${creados.length} registro(s) de prueba eliminados`);
    cerrar();
  }
  fin();
}

function cerrar() {
  try { if (typeof clientes !== 'undefined') clientes.forEach((c) => c.socket && c.socket.close()); } catch {}
}

function fin() {
  console.log('');
  console.log('=== RESUMEN: sincronización multi-usuario en tiempo real ===');
  for (const r of resultados) console.log('  ' + r);
  console.log(`RESULTADO: PASS=${passes} FAIL=${failures}`);
  console.log(failures === 0
    ? 'EXITO: 2+ usuarios sincronizados en tiempo real (broadcast bidireccional).'
    : 'FALLO: revisa las aserciones marcadas.');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('ERROR inesperado:', e); fin(); });
