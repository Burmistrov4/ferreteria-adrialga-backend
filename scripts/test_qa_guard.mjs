#!/usr/bin/env node
/**
 * test_qa_guard.mjs — ADR-002/007 · Pruebas de la lógica de salvaguarda SIN BD.
 *
 * Ejercita el módulo real qa_guard.cjs con casos derivados del mega prompt §5.3
 * y de la auditoría de cierre de P0 (alias de loopback, normalización de URL,
 * segmentos de ruta extra, credenciales con caracteres especiales, etc.).
 *
 * NO conecta ni escribe en ninguna base de datos. Código de salida 0 = TODO PASS.
 * Garantía anti-fuga: NINGUNA línea de salida puede contener el usuario o la
 * contraseña de prueba; la infracción se cuenta como FAIL.
 *
 * Uso: node scripts/test_qa_guard.mjs
 */
import guard from './qa_guard.cjs';

let pass = 0;
let fail = 0;
const lines = []; // captura TODA la salida para la aserción anti-fuga

function emit(tag, name, detalle) {
  const msg = `${tag} · ${name}${detalle ? ` · ${detalle}` : ''}`;
  lines.push(msg);
  if (tag === 'PASS') console.log(msg);
  else console.error(msg);
}

function check(name, cond, detalle = '') {
  if (cond) {
    pass++;
    emit('PASS', name, detalle);
  } else {
    fail++;
    emit('FAIL', name, detalle);
  }
}

// Credenciales de prueba (NUNCA deben aparecer en la salida).
const SECRET_USER = 'qaTester';
const SECRET_PASS = 's3cr3tPass'; // sin '@' para no romper el parseo de URL
function url(host, db, proto = 'mysql', user = SECRET_USER, pw = SECRET_PASS, port = 3306, query = '') {
  return `${proto}://${user}:${pw}@${host}:${port}/${db}${query}`;
}

// 1) Aceptar: localhost + base adrialga_qa (rol esperado)
{
  const r = guard.validarUrlQa(url('localhost', 'adrialga_qa'), url('localhost', 'adrialga'));
  check('localhost+adrialga_qa es aceptado', r.ok, r.ok ? '' : r.error);
}

// 2) Rechazar host remoto
{
  const r = guard.validarUrlQa(url('203.0.113.9', 'adrialga_qa'), url('203.0.113.9', 'adrialga'));
  check('host remoto es rechazado', !r.ok && /loopback/.test(r.error), r.error);
}

// 3) Rechazar protocolo no permitido
{
  const r = guard.validarUrlQa(
    url('localhost', 'adrialga_qa', 'postgres'),
    url('localhost', 'adrialga', 'postgres'),
  );
  check('protocolo no permitido es rechazado', !r.ok && /protocolo/.test(r.error), r.error);
}

// 3b) Aceptar protocolo mysql2: (alias permitido)
{
  const r = guard.validarUrlQa(
    url('localhost', 'adrialga_qa', 'mysql2'),
    url('localhost', 'adrialga', 'mysql2'),
  );
  check('protocolo mysql2 es aceptado', r.ok, r.ok ? '' : r.error);
}

// 4) Rechazar URL malformada
{
  const r = guard.validarUrlQa('esto-no-es-una-url', '');
  check('URL QA malformada es rechazada', !r.ok, r.error);
}

// 5) Rechazar base de QA incorrecta
{
  const r = guard.validarUrlQa(url('localhost', 'adrialga_prod'), url('localhost', 'adrialga'));
  check('base QA != adrialga_qa es rechazada', !r.ok && /adrialga_qa/.test(r.error), r.error);
}

// 6) Rechazar URL real que ya apunta a adrialga_qa (derivar desde sí misma)
{
  const r = guard.validarLocal(url('localhost', 'adrialga_qa'));
  check('URL real ya adrialga_qa es rechazada', !r.ok, r.error);
}

// 7) Rechazar QA idéntica a la real (mismo host+base)
{
  const r = guard.validarUrlQa(url('localhost', 'adrialga_qa'), url('localhost', 'adrialga_qa'));
  check('QA idéntica a real es rechazada', !r.ok && /coincide/.test(r.error), r.error);
}

// 8) Credenciales NUNCA en la salida sanitizada
{
  const s = guard.sanitizar(url('localhost', 'adrialga_qa'));
  check('sanitizar omite credenciales', !s.includes(SECRET_USER) && !s.includes(SECRET_PASS), s);
}

// 9) 127.0.0.1 + puerto explícito + query legítima: aceptar; detalle SANITIZADO
{
  const q = '?connection_limit=5';
  const r = guard.validarUrlQa(
    url('127.0.0.1', 'adrialga_qa', 'mysql', 'app', 'pw123', 3306, q),
    url('127.0.0.1', 'adrialga'),
  );
  check('127.0.0.1 + puerto + query es aceptado', r.ok, r.ok ? '' : r.error);
  const d = guard.derivarUrlQa(url('127.0.0.1', 'adrialga', 'mysql', 'app', 'pw123', 3306, q));
  // CORREGIDO: no imprimir d.qaUrl (tiene credenciales); usar sanitizar.
  check(
    'derivar conserva query legítima',
    d.ok && d.qaUrl.includes('connection_limit=5'),
    d.ok ? guard.sanitizar(d.qaUrl) : '',
  );
}

// 10) ::1 (IPv6 loopback) — requiere corchetes en la URL
{
  const ipv6Qa = 'mysql://app:pw123@[::1]:3306/adrialga_qa';
  const ipv6Real = 'mysql://app:pw123@[::1]:3306/adrialga';
  const r = guard.validarUrlQa(ipv6Qa, ipv6Real);
  check('::1 loopback es aceptado', r.ok, r.ok ? '' : r.error);
}

// 11) derivar desde real local cambia la base a /adrialga_qa; detalle SANITIZADO
{
  const d = guard.derivarUrlQa(url('localhost', 'adrialga'));
  check(
    'derivar produce /adrialga_qa',
    d.ok && d.qaUrl.includes('/adrialga_qa'),
    d.ok ? guard.sanitizar(d.qaUrl) : '',
  );
}

// 12) derivar desde real remota es rechazado
{
  const d = guard.derivarUrlQa(url('203.0.113.9', 'adrialga'));
  check('derivar desde real remota es rechazado', !d.ok, d.error);
}

// 13) Rechazar segmentos de ruta extra: /adrialga_qa/otra_base
{
  const r = guard.validarUrlQa(
    'mysql://app:pw123@localhost:3306/adrialga_qa/otra_base',
    'mysql://app:pw123@localhost:3306/adrialga',
  );
  check('segmento de ruta extra es rechazado', !r.ok && /exactamente/.test(r.error), r.error);
}

// 14) Rechazar colisión por alias de loopback distintos (127.0.0.1 vs localhost)
{
  const r = guard.validarUrlQa(
    'mysql://app:pw123@localhost:3306/adrialga_qa',
    'mysql://app:pw123@127.0.0.1:3306/adrialga_qa',
  );
  check('colisión por alias loopback es rechazada', !r.ok && /coincide/.test(r.error), r.error);
}

// 15) Puerto no estándar en loopback es aceptado (no sobre-restringir puerto)
{
  const r = guard.validarUrlQa(
    'mysql://app:pw123@localhost:9999/adrialga_qa',
    'mysql://app:pw123@localhost:9999/adrialga',
  );
  check('puerto no estándar en loopback es aceptado', r.ok, r.ok ? '' : r.error);
}

// 16) Credenciales con caracteres especiales (codificados) nunca se filtran
{
  const su = encodeURIComponent('user@dom');
  const sp = encodeURIComponent('p@ss/w:rd');
  const urlSpecial = `mysql://${su}:${sp}@localhost:3306/adrialga_qa`;
  const r = guard.validarUrlQa(urlSpecial, 'mysql://localhost:3306/adrialga');
  check('URL con credenciales especiales es aceptada', r.ok, r.ok ? '' : r.error);
  const s = guard.sanitizar(urlSpecial);
  check(
    'credenciales con caracteres especiales no se filtran',
    !s.includes('user@dom') && !s.includes('p@ss/w:rd'),
    s,
  );
}

// 17) URL de entorno entrecomillada se normaliza
{
  const r = guard.validarLocal('"mysql://localhost:3306/adrialga"');
  check('URL real entrecomillada se normaliza', r.ok, r.ok ? '' : r.error);
  const r2 = guard.validarUrlQa("'mysql://localhost:3306/adrialga_qa'", 'mysql://localhost:3306/adrialga');
  check('URL QA entrecomillada se normaliza y acepta', r2.ok, r2.ok ? '' : r2.error);
}

// 18) Insensibilidad a mayúsculas en protocolo/base; barra final tolerada
{
  const r = guard.validarUrlQa(
    'MYSQL://LOCALHOST:3306/adrialga_qa',
    'MYSQL://LOCALHOST:3306/adrialga',
  );
  check('protocolo/base insensibles a mayúsculas', r.ok, r.ok ? '' : r.error);
  const r2 = guard.validarUrlQa(
    'mysql://localhost:3306/adrialga_qa/',
    'mysql://localhost:3306/adrialga',
  );
  check('barra final en base es tolerada', r2.ok, r2.ok ? '' : r2.error);
}

// 19) URL real faltante/malformada rechazada por validarLocal
{
  const r = guard.validarLocal('');
  check('URL real vacía es rechazada', !r.ok, r.error);
  const r2 = guard.validarLocal('esto-no-es-url');
  check('URL real malformada es rechazada', !r2.ok, r2.error);
}

// 20) validarHostLocal: rechaza remoto, acepta loopback (scripts admin/migración)
{
  const r = guard.validarHostLocal('mysql://203.0.113.9:3306/adrialga');
  check('validarHostLocal rechaza remoto', !r.ok, r.error);
  const r2 = guard.validarHostLocal('mysql://127.0.0.1:3306/adrialga');
  check('validarHostLocal acepta loopback', r2.ok, r2.ok ? '' : r2.error);
}

// 20) validarUrlQa con URL real vacía/malformada: la QA se valida por sus propios
// méritos (loopback + base exacta); la colisión no puede comprobarse pero el
// destino QA sigue siendo seguro (adrialga_qa local).
{
  const r = guard.validarUrlQa(url('localhost', 'adrialga_qa'), '');
  check('QA válida con real vacía es aceptada (destino seguro per se)', r.ok, r.ok ? '' : r.error);
  const r2 = guard.validarUrlQa(url('localhost', 'adrialga_qa'), 'no-es-url');
  check('QA válida con real malformada es aceptada (sin colisión comprobable)', r2.ok, r2.ok ? '' : r2.error);
}

// 21b) valor estilo .env: comillas envolventes + espacios → normalizado y aceptado
{
  const raw = "  \"mysql://app:pw123@localhost:3306/adrialga_qa\"  ";
  const r = guard.validarUrlQa(raw, " 'mysql://app:pw123@localhost:3306/adrialga' ");
  check('valor estilo .env (comillas+espacios) se normaliza y acepta', r.ok, r.ok ? '' : r.error);
}

// 21c) independencia de orden: mismas validaciones en distinto orden y repetidas
// producen resultados idénticos (el módulo no guarda estado compartido).
{
  const qa = url('localhost', 'adrialga_qa');
  const real = url('localhost', 'adrialga');
  const a1 = guard.validarLocal(real).ok;
  const a2 = guard.validarUrlQa(qa, '').ok;
  const b2 = guard.validarUrlQa(qa, '').ok; // mismo caso repetido → mismo resultado
  const a3 = guard.validarLocal(url('203.0.113.9', 'adrialga')).ok;
  const a4 = guard.validarLocal(real).ok; // caso repetido tras otros → mismo resultado
  check(
    'independencia de orden (sin estado compartido)',
    a1 === true && a2 === true && b2 === a2 && a3 === false && a4 === a1,
  );
}

// 21) ANTI-FUGA: NINGUNA línea de salida contiene usuario/contraseña de prueba
{
  let leak = false;
  const leakLines = [];
  for (const ln of lines) {
    if (ln.includes(SECRET_USER) || ln.includes(SECRET_PASS)) {
      leak = true;
      leakLines.push(ln);
    }
  }
  check(
    'NINGUNA salida contiene usuario/contraseña de prueba',
    !leak,
    leak ? `LÍNEAS CON FUGA: ${leakLines.length}` : `líneas revisadas=${lines.length}`,
  );
}

console.log(`\nQA-GUARD: PASS=${pass} FAIL=${fail}`);
process.exit(fail ? 1 : 0);
