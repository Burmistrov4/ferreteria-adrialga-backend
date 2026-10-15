/**
 * Integración LAN/Socket.IO contra la base QA aislada.
 * - Nunca escribe en DB; /api/health es lectura y el broadcast se emite en memoria.
 * - Deriva DATABASE_URL de .env y cambia únicamente el nombre de base a adrialga_qa.
 * - Verifica que clientes sin token / con token inválido sean rechazados,
 *   y que dos clientes autenticados reciban el mismo db_update.
 * Requiere socket.io-client instalado temporalmente o como dependencia de desarrollo.
 */
require('dotenv').config();

const guard = require('./qa_guard.cjs');
if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL no configurada; no se inicia la prueba.');
}
const _vReal = guard.validarLocal(process.env.DATABASE_URL);
if (!_vReal.ok) {
  throw new Error(`DATABASE_URL real no es local válida (${guard.sanitizar(process.env.DATABASE_URL)}): ${_vReal.error}`);
}
const _d = guard.derivarUrlQa(process.env.DATABASE_URL);
if (!_d.ok) { throw new Error(`No se pudo derivar QA: ${_d.error}`); }
process.env.DATABASE_URL = _d.qaUrl;
process.env.PORT = process.env.TEST_PORT || '3000';

const secret = process.env.JWT_SECRET;
if (!secret) throw new Error('JWT_SECRET ausente; no se inicia la prueba.');

const jwt = require('jsonwebtoken');
const { io } = require('socket.io-client');
require('./../dist/index.js');
const { IoStore } = require('./../dist/utils/socket');

// Opcional: apuntar a una IP de la interfaz LAN para probar el bind 0.0.0.0.
const origin = process.env.TEST_LAN_URL || `http://127.0.0.1:${process.env.PORT}`;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitHealth() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(origin + '/api/health');
      if (r.status === 200) return;
    } catch (_) {}
    await wait(500);
  }
  throw new Error('Servidor QA no respondió al healthcheck en 20 s.');
}

function rejectedWithoutAuth(auth) {
  return new Promise((resolve, reject) => {
    const s = io(origin, { transports: ['websocket'], reconnection: false, auth });
    const timer = setTimeout(() => {
      s.close();
      reject(new Error('El socket sin credenciales/token inválido no fue rechazado.'));
    }, 5000);
    s.on('connect', () => {
      clearTimeout(timer);
      s.close();
      reject(new Error('El servidor aceptó un socket sin token válido.'));
    });
    s.on('connect_error', () => {
      clearTimeout(timer);
      s.close();
      resolve(true);
    });
  });
}

function connectedSocket(token) {
  return new Promise((resolve, reject) => {
    const s = io(origin, {
      transports: ['websocket'],
      reconnection: false,
      auth: { token },
    });
    const timer = setTimeout(() => {
      s.close();
      reject(new Error('Socket autenticado no conectó en 5 s.'));
    }, 5000);
    s.on('connect', () => {
      clearTimeout(timer);
      resolve(s);
    });
    s.on('connect_error', (e) => {
      clearTimeout(timer);
      s.close();
      reject(new Error('Handshake JWT rechazado: ' + e.message));
    });
  });
}

(async () => {
  let a;
  let b;
  try {
    await waitHealth();
    console.log('HEALTH_QA=PASS');
    await rejectedWithoutAuth({});
    console.log('SOCKET_NO_TOKEN=REJECTED');
    await rejectedWithoutAuth({ token: 'invalid-token' });
    console.log('SOCKET_INVALID_TOKEN=REJECTED');

    const token = jwt.sign({ sub: 'qa-socket-test' }, secret, { expiresIn: '60s' });
    [a, b] = await Promise.all([connectedSocket(token), connectedSocket(token)]);
    console.log('SOCKET_AUTHENTICATED_CLIENTS=2');

    const eventA = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Cliente A no recibió db_update')), 3000);
      a.once('db_update', (payload) => { clearTimeout(timer); resolve(payload); });
    });
    const eventB = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Cliente B no recibió db_update')), 3000);
      b.once('db_update', (payload) => { clearTimeout(timer); resolve(payload); });
    });

    IoStore.emitDbUpdate('test_lan', 'Prueba de sincronización LAN', { prueba: true });
    const [pa, pb] = await Promise.all([eventA, eventB]);
    if (pa.modulo !== 'test_lan' || pb.modulo !== 'test_lan' || pa.prueba !== true || pb.prueba !== true) {
      throw new Error('Payload db_update inesperado en uno de los clientes.');
    }
    console.log('BROADCAST_TWO_CLIENTS=PASS');
    console.log('SOCKET_LAN_TEST=PASS');
    a.close();
    b.close();
    // Cerrar Socket.IO/HTTP antes de salir evita dejar handles libuv abiertos
    // y hace que el código de salida represente el resultado real del test.
    IoStore.io.close(() => { process.exitCode = 0; });
  } catch (e) {
    console.error('SOCKET_LAN_TEST=FAIL: ' + (e?.message ?? e));
    a?.close();
    b?.close();
    if (IoStore.io) IoStore.io.close(() => { process.exitCode = 1; });
    else process.exitCode = 1;
  }
})();
