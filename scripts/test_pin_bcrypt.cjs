// PRUEBA EXPERIMENTAL: PIN de supervisor con hash bcrypt + arqueo pendiente.
// Ejecutar con el backend corriendo en :3000:  node scripts/test_pin_bcrypt.cjs
const BASE = 'http://localhost:3000/api';

const assert = (cond, msg) => {
  if (!cond) throw new Error(`FALLO: ${msg}`);
  console.log(`OK  ${msg}`);
};

(async () => {
  // ── 0. Login como cajero de prueba (admin funge como vendedor) ──
  const loginRes = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Credencial: 'admin', Password: 'admin123' })
  });
  assert(loginRes.ok, `Login (HTTP ${loginRes.status})`);
  const { token } = await loginRes.json();
  const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  // ── 1. El PIN en la BD NO es texto plano ──
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  const supervisor = await prisma.usuarios.findUnique({
    where: { Credencial: 'supervisor' },
    select: { PIN_Operaciones: true }
  });
  await prisma.$disconnect();
  assert(
    supervisor.PIN_Operaciones !== '1234',
    'PIN persistido NO es "1234" en claro'
  );
  assert(
    /^\$2[aby]\$10\$/.test(supervisor.PIN_Operaciones ?? ''),
    `PIN persistido es hash bcrypt (prefijo ${String(supervisor.PIN_Operaciones).slice(0, 7)}…)`
  );

  // ── 2. PIN correcto valida vía endpoint (bcrypt.compare) ──
  const okRes = await fetch(`${BASE}/auth/validar-pin-supervisor`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ pin: '1234' })
  });
  assert(okRes.ok, `PIN correcto → HTTP ${okRes.status}`);
  const okBody = await okRes.json();
  assert(okBody.valido === true, `PIN correcto aceptado (usuario: ${okBody.nombre})`);

  // ── 3. PIN incorrecto rechazado ──
  const badRes = await fetch(`${BASE}/auth/validar-pin-supervisor`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ pin: '9999' })
  });
  assert(badRes.status === 401, `PIN incorrecto → HTTP ${badRes.status}`);
  const badBody = await badRes.json();
  assert(badBody.valido === false, 'PIN incorrecto marcado inválido');

  // ── 4. PIN vacío rechazado con 400 ──
  const emptyRes = await fetch(`${BASE}/auth/validar-pin-supervisor`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ pin: '' })
  });
  assert(emptyRes.status === 400, `PIN vacío → HTTP ${emptyRes.status}`);

  console.log('\nPIN BCRYPT: TODAS LAS PRUEBAS EN VERDE');
})().catch((e) => {
  console.log(`❌ ${e.message}`);
  process.exit(1);
});
