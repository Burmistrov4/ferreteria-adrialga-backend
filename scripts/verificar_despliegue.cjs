// Prueba de humo de un despliegue de Adrialga.
//
// Verifica, contra un servidor YA DESPLEGADO, las tres cosas que deben
// funcionar para que la demo sea viable:
//   1. La API responde y el LOGIN devuelve token.
//   2. El canal Socket.IO acepta la conexión (de él depende el Monitor en vivo).
//   3. La web unificada se sirve desde el mismo origen.
//
// Existe porque un despliegue puede "arrancar" y aun así estar roto: en
// producción sobre IP o dominio propio el middleware CORS devolvía 500 en todos
// los POST (corregido el 2026-10-15). Este script detecta esa clase de fallo en
// un comando.
//
// Uso:
//   node scripts/verificar_despliegue.cjs --url https://mi-servidor:3000 \
//        --credencial admin --password ****
//
// La credencial también se puede pasar por entorno (CRED / PASS) para no
// dejarla en el historial del shell.
const { io } = require('socket.io-client');

function args() {
  const a = process.argv.slice(2);
  const get = (flag, def) => {
    const i = a.indexOf(flag);
    return i >= 0 && a[i + 1] ? a[i + 1] : def;
  };
  const url = get('--url', 'http://localhost:3000').replace(/\/$/, '');
  return {
    url,
    // Por defecto se prueba como MISMO ORIGEN: es el caso real del despliegue
    // unificado y el que antes fallaba.
    origin: get('--origin', url),
    cred: get('--credencial', process.env.CRED || ''),
    pass: get('--password', process.env.PASS || ''),
    timeout: Number(get('--timeout', '10000')),
  };
}

const resultados = [];
function anotar(nombre, ok, detalle) {
  resultados.push({ nombre, ok, detalle });
  console.log(`  ${ok ? 'PASS' : 'FALLA'} · ${nombre}${detalle ? ' — ' + detalle : ''}`);
}

(async () => {
  const { url, origin, cred, pass, timeout } = args();
  console.log(`=== Verificación de despliegue ===\n  destino : ${url}\n  origen  : ${origin}\n`);

  // 1. Salud de la API
  try {
    const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(timeout) });
    anotar('API responde /api/health', r.ok, `status=${r.status}`);
  } catch (e) {
    anotar('API responde /api/health', false, e.message);
  }

  // 2. Login (el POST que fallaba con 500 por CORS)
  let token = '';
  if (!cred || !pass) {
    anotar('Login devuelve token', false, 'faltan credenciales (--credencial / --password o CRED / PASS)');
  } else {
    try {
      const r = await fetch(`${url}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({ Credencial: cred, Password: pass }),
        signal: AbortSignal.timeout(timeout),
      });
      const cuerpo = await r.json().catch(() => ({}));
      token = cuerpo.token || cuerpo.Token || '';
      anotar(
        'Login devuelve token',
        r.status === 200 && !!token,
        `status=${r.status}${r.status === 500 ? ' (500 suele indicar origen rechazado por CORS)' : ''}`
      );
    } catch (e) {
      anotar('Login devuelve token', false, e.message);
    }
  }

  // 3. Socket.IO
  if (!token) {
    anotar('Socket.IO conecta', false, 'sin token no se puede probar');
  } else {
    await new Promise((resolve) => {
      const s = io(url, {
        transports: ['websocket'],
        extraHeaders: { Origin: origin },
        auth: { token },
        reconnection: false,
        timeout,
      });
      const fin = (ok, detalle) => {
        s.close();
        anotar('Socket.IO conecta', ok, detalle);
        resolve();
      };
      s.on('connect', () => fin(true, 'canal en vivo operativo'));
      s.on('connect_error', (e) => fin(false, e.message));
      setTimeout(() => fin(false, 'tiempo agotado'), timeout + 2000);
    });
  }

  // 4. Web unificada
  try {
    const r = await fetch(`${url}/`, { headers: { Origin: origin }, signal: AbortSignal.timeout(timeout) });
    const html = await r.text();
    anotar('Web unificada servida', r.ok && html.includes('<base href='), `status=${r.status} bytes=${html.length}`);
  } catch (e) {
    anotar('Web unificada servida', false, e.message);
  }

  const fallos = resultados.filter((r) => !r.ok).length;
  console.log(`\n=== ${resultados.length - fallos}/${resultados.length} correctas ===`);
  process.exit(fallos === 0 ? 0 : 1);
})();
