#!/usr/bin/env node
/**
 * verificar_monitor_bd.cjs — Verifica que el Monitor de BD reciba el esquema
 * COMPLETO y navegable, contra un servidor ya corriendo (local o producción).
 *
 * Aserciones:
 *   C1  modo=presentacion devuelve exactamente las 12 tablas del modelo
 *   C2  ninguna tabla viene sin columnas (0 columnas = dato incompleto)
 *   C3  toda tabla tiene al menos una PK
 *   C4  hay relaciones (FK) resueltas entre tablas visibles
 *   C5  los conteos son numéricos y coherentes (filas >= activos cuando aplica)
 *   C6  modo=full devuelve al menos las 12 + tablas internas
 *   C7  el resumen global cuadra con la suma de filas por tabla
 *
 * Imprime un cuadro por tabla: columnas · filas · activos · PK · FK.
 * No imprime credenciales ni tokens.
 *
 * Uso:
 *   BASE=https://... ADM_CRED=... ADM_PASS=... node scripts/verificar_monitor_bd.cjs
 */
const BASE = (process.env.BASE || 'http://127.0.0.1:3000').replace(/\/$/, '');
const CRED = process.env.ADM_CRED;
const PASS = process.env.ADM_PASS;

const ESPERADAS = [
  'usuarios', 'clientes', 'proveedores', 'categorias', 'productos', 'caja',
  'movimientos_caja', 'facturas', 'detalle_facturas', 'pagos',
  'notas_entrega_entrada', 'detalle_notas_entrega',
];

let passes = 0;
let failures = 0;
function assert(ok, label) {
  if (ok) { passes++; console.log(`  PASS  ${label}`); }
  else { failures++; console.log(`  FAIL  ${label}`); }
}

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

async function main() {
  console.log(`BASE: ${BASE}\n`);
  if (!CRED || !PASS) { console.error('ABORTADO: faltan ADM_CRED / ADM_PASS'); process.exit(3); }

  const login = await api('/api/auth/login', {
    method: 'POST', body: { Credencial: CRED, Password: PASS },
  });
  if (login.status !== 200) { console.error(`ABORTADO: login ${login.status}`); process.exit(3); }
  const token = login.json && (login.json.token || login.json.Token);
  console.log('  login OK (token no impreso)\n');

  // ── modo presentacion ────────────────────────────────────────────────────
  const pres = await api('/api/monitor/esquema?modo=presentacion', { token });
  assert(pres.status === 200, `C0 GET monitor/esquema?modo=presentacion -> 200 (recibió ${pres.status})`);
  if (pres.status !== 200) { console.log(pres.raw.slice(0, 300)); fin(); return; }
  const d = pres.json;

  console.log(`  base: ${d.base} · generadoEn: ${d.generadoEn}`);
  console.log(`  resumen: ${JSON.stringify(d.resumen)}\n`);

  const nombres = d.tablas.map((t) => t.nombre);
  assert(nombres.length === 12, `C1 modo presentacion -> 12 tablas (recibió ${nombres.length})`);
  const faltantes = ESPERADAS.filter((e) => !nombres.includes(e));
  assert(faltantes.length === 0, `C1 las 12 del modelo están presentes (faltan: ${faltantes.join(', ') || 'ninguna'})`);

  const sinColumnas = d.tablas.filter((t) => !t.columnas || t.columnas.length === 0).map((t) => t.nombre);
  assert(sinColumnas.length === 0, `C2 ninguna tabla viene sin columnas (vacías: ${sinColumnas.join(', ') || 'ninguna'})`);

  const sinPk = d.tablas.filter((t) => !t.columnas.some((c) => c.pk)).map((t) => t.nombre);
  assert(sinPk.length === 0, `C3 toda tabla tiene PK (sin PK: ${sinPk.join(', ') || 'ninguna'})`);

  assert(Array.isArray(d.relaciones) && d.relaciones.length > 0,
    `C4 relaciones FK presentes (${d.relaciones ? d.relaciones.length : 0})`);

  const conteoMalo = d.tablas.filter((t) => typeof t.filas !== 'number' || t.filas < 0);
  assert(conteoMalo.length === 0, `C5 conteos numéricos válidos (malos: ${conteoMalo.map((t) => t.nombre).join(', ') || 'ninguno'})`);

  const incoherentes = d.tablas.filter((t) => t.activos !== null && t.activos > t.filas);
  assert(incoherentes.length === 0, `C5 activos <= filas en todas (incoherentes: ${incoherentes.map((t) => t.nombre).join(', ') || 'ninguna'})`);

  const suma = d.tablas.reduce((a, t) => a + t.filas, 0);
  assert(d.resumen && d.resumen.filas === suma, `C7 el resumen cuadra con la suma por tabla (${d.resumen && d.resumen.filas} vs ${suma})`);

  console.log('\n  ── Detalle por tabla (modo presentación) ──');
  console.log('  ' + 'TABLA'.padEnd(24) + 'COLS'.padEnd(6) + 'FILAS'.padEnd(10) + 'ACTIVOS'.padEnd(10) + 'PK'.padEnd(5) + 'FK');
  for (const t of d.tablas) {
    const cols = t.columnas.length;
    const pk = t.columnas.filter((c) => c.pk).length;
    const fk = t.columnas.filter((c) => c.fk).length;
    const act = t.activos === null ? '—' : String(t.activos);
    console.log('  ' + t.nombre.padEnd(24) + String(cols).padEnd(6) +
      String(t.filas).padEnd(10) + act.padEnd(10) + String(pk).padEnd(5) + String(fk));
  }

  // ── modo full ────────────────────────────────────────────────────────────
  const full = await api('/api/monitor/esquema?modo=full', { token });
  if (full.status === 200 && full.json && full.json.tablas) {
    assert(full.json.tablas.length >= 12,
      `C6 modo full -> al menos 12 tablas (recibió ${full.json.tablas.length})`);
    console.log(`\n  modo full: ${full.json.tablas.length} tablas · ${full.json.resumen.filas} filas`);
  } else {
    assert(false, `C6 modo full respondió ${full.status}`);
  }

  fin();
}

function fin() {
  console.log(`\nRESULTADO: PASS=${passes} FAIL=${failures}`);
  console.log(failures === 0 ? 'EXITO: el Monitor recibe el esquema completo y navegable.' : 'FALLO: revisa arriba.');
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error('ERROR:', e); process.exit(1); });
