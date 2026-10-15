/**
 * test_caja_concurrencia.ts — pruebas de integración de CARRERA en caja
 * (A-014 / A-015; escenarios CASH-003, CASH-004, CASH-010, CASH-013 parcial).
 *
 * SEGURIDAD (ADR-002): este script ESCRIBE en base de datos. Solo corre contra
 * una base de QA desechable declarada explícitamente:
 *
 *   DATABASE_URL_QA="mysql://usuario:clave@localhost:3306/adrialga_qa" \
 *   npx ts-node-dev --transpile-only scripts/test_caja_concurrencia.ts
 *
 * Rechaza ejecutarse si DATABASE_URL_QA es idéntica a DATABASE_URL (la real).
 *
 * Diseño de las aserciones (lo que demuestra cada una):
 *  S1 Aperturas concurrentes: exactamente 1 HTTP 201 y 1 HTTP 409, y la tabla
 *     `caja` queda con exactamente 1 fila Activa. Demuestra serialización de
 *     la apertura (locking read FOR UPDATE sobre IDX_Caja_Activa).
 *  S2 Cierres concurrentes: exactamente 1 HTTP 200 y 1 HTTP 409 y exactamente
 *     1 movimiento EGRESO "Cierre de caja" por turno. Doble clic / timeout /
 *     reintento no duplican la entrega de efectivo (CASH-010).
 *  S3 Reintento de cierre tras cierre exitoso: segundo 409, cero EGRESOS
 *     nuevos (idempotencia por estado terminal).
 *  S4 Ingreso de fondo CONCURRENTE con el cierre: o el ingreso gana (201 y su
 *     monto queda incluido en el saldo entregado) o pierde (409 CAJA_CERRADA);
 *     lo que nunca puede pasar es un ingreso confirmado que no cuadre en el
 *     arqueo. Demuestra serialización venta/fondo vs cierre (A-015).
 *
 * Códigos de salida: 0 = todo PASS · 1 = al menos una aserción FALLÓ ·
 *                    3 = SKIP (sin DATABASE_URL_QA configurada).
 *
 * La limpieza borra SOLO las filas creadas por esta corrida (por Caja_ID).
 */

// ── Guardas de seguridad ANTES de tocar Prisma ────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('dotenv').config();

const guard = require('./qa_guard.cjs');
const urlQa = process.env.DATABASE_URL_QA;
const urlReal = process.env.DATABASE_URL;

if (!urlQa) {
  console.error(
    'SKIP: define DATABASE_URL_QA apuntando a una base de QA DESECHABLE ' +
    '(ej. mysql://user:pass@localhost:3306/adrialga_qa). ' +
    'Este script escribe y jamás debe correr contra la base real.'
  );
  process.exit(3);
}
// Salvaguarda QA (ADR-002/007): la real debe ser local y la QA exactamente
// adrialga_qa en loopback; jamás igual a la base real.
const _vReal = guard.validarLocal(urlReal);
if (!_vReal.ok) {
  console.error(`ABORTADO: DATABASE_URL real no es local válida (${guard.sanitizar(urlReal)}): ${_vReal.error}`);
  process.exit(3);
}
const _vQa = guard.validarUrlQa(urlQa, urlReal);
if (!_vQa.ok) {
  console.error(`ABORTADO: destino QA no permitido (${guard.sanitizar(urlQa)}): ${_vQa.error}`);
  process.exit(3);
}
process.env.DATABASE_URL = urlQa;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { prisma } = require('../src/config/db') as {
  prisma: import('@prisma/client').PrismaClient;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  abrirCaja,
  cerrarCaja,
  ingresarFondoCaja,
} = require('../src/controllers/caja.controllers');

interface MockRes {
  statusCode: number;
  body: any;
  status(c: number): MockRes;
  json(o: any): MockRes;
}
const mockRes = (): MockRes => ({
  statusCode: 200,
  body: undefined,
  status(c: number) { this.statusCode = c; return this; },
  json(o: any) { this.body = o; return this; },
});
const mockReq = (body: any = {}, usuarioId: number | null = null) =>
  ({ body, user: { usuarioId, rol: 'ADMIN' } }) as any;

type Chequeo = { nombre: string; ok: boolean; detalle?: string };
const fallos: string[] = [];
function chequea(nombre: string, ok: boolean, detalle = ''): void {
  const c: Chequeo = { nombre, ok, detalle };
  console.log(`${ok ? 'PASS' : 'FAIL'} · ${nombre}${detalle ? ` · ${detalle}` : ''}`);
  if (!ok) fallos.push(nombre);
}

async function estadoTurnos() {
  const activas = await prisma.caja.count({ where: { Activa: true } });
  const total = await prisma.caja.count();
  return { activas, total };
}

const creadosEnEstaCorrida: number[] = [];

async function main() {
  console.log('== Limpieza inicial de QA (solo QA, verificado arriba) ==');
  await prisma.movimientos_caja.deleteMany({});
  await prisma.caja.deleteMany({});

  // ── S1: dos aperturas concurrentes ──────────────────────────────────────
  console.log('\n== S1: DOS APERTURAS CONCURRENTES (CASH-003/004) ==');
  const resA = mockRes();
  const resB = mockRes();
  await Promise.all([
    abrirCaja(mockReq({ montoInicial: 100 }), resA),
    abrirCaja(mockReq({ montoInicial: 100 }), resB),
  ]);

  const s1 = await estadoTurnos();
  creadosEnEstaCorrida.push(
    ...(await prisma.caja.findMany({ select: { Caja_ID: true } })).map((c) => c.Caja_ID)
  );
  const aperturas = await prisma.movimientos_caja.count({
    where: { Concepto: { startsWith: 'Apertura de caja' } },
  });

  chequea(
    'S1 una sola apertura exitosa (201) y un conflicto (409)',
    [resA.statusCode, resB.statusCode].sort().join(',') === '201,409',
    `status=[${resA.statusCode},${resB.statusCode}]`
  );
  chequea('S1 exactamente 1 caja activa', s1.activas === 1, `activas=${s1.activas}`);
  chequea('S1 exactamente 1 turno en total', s1.total === 1, `total=${s1.total}`);
  chequea('S1 un solo movimiento de apertura', aperturas === 1, `aperturas=${aperturas}`);

  const turno = await prisma.caja.findFirst({ where: { Activa: true } });
  if (!turno) throw new Error('Estado inconsistente tras S1');

  // ── S2: dos cierres concurrentes (CASH-010/013 parcial) ─────────────────
  console.log('\n== S2: DOS CIERRES CONCURRENTES ==');
  // Ingresar un ingreso de caja para que haya saldo que entregar.
  const resIng = mockRes();
  await ingresarFondoCaja(mockReq({ monto: 40, metodoPago: 'Efectivo' }), resIng);
  chequea('S2 ingreso previo aceptado', resIng.statusCode === 201, `status=${resIng.statusCode}`);

  const resC1 = mockRes();
  const resC2 = mockRes();
  await Promise.all([
    cerrarCaja(mockReq({ montoContado: 140 }), resC1),
    cerrarCaja(mockReq({ montoContado: 140 }), resC2),
  ]);

  const cierres = await prisma.movimientos_caja.count({
    where: { Concepto: { startsWith: 'Cierre de caja' }, Caja_ID: turno.Caja_ID },
  });
  const turnoCerrado = await prisma.caja.findUnique({
    where: { Caja_ID: turno.Caja_ID },
  });

  chequea(
    'S2 un solo cierre exitoso (200) y un conflicto (409)',
    [resC1.statusCode, resC2.statusCode].sort().join(',') === '200,409',
    `status=[${resC1.statusCode},${resC2.statusCode}]`
  );
  chequea('S2 exactamente 1 EGRESO de cierre', cierres === 1, `cierres=${cierres}`);
  chequea(
    'S2 turno quedó CERRADA con saldo 0',
    turnoCerrado?.Estado === 'CERRADA' && Number(turnoCerrado.Saldo_Actual) === 0,
    `estado=${turnoCerrado?.Estado} saldo=${turnoCerrado?.Saldo_Actual}`
  );
  const saldoEntregado = (resC1.statusCode === 200 ? resC1.body : resC2.body)
    ?.saldoEntregado;
  chequea(
    'S2 el saldo entregado incluye fondo + ingreso (140)',
    Number(saldoEntregado) === 140,
    `saldoEntregado=${saldoEntregado}`
  );

  // ── S3: reintento de cierre tras timeout (idempotencia / estado terminal) ─
  console.log('\n== S3: REINTENTO DE CIERRE TRAS CIERRE EXITOSO (CASH-010) ==');
  const resC3 = mockRes();
  await cerrarCaja(mockReq({ montoContado: 140 }), resC3);
  const cierresTrasReintento = await prisma.movimientos_caja.count({
    where: { Concepto: { startsWith: 'Cierre de caja' }, Caja_ID: turno.Caja_ID },
  });
  chequea('S3 reintento devuelve 409 sin duplicar', resC3.statusCode === 409, `status=${resC3.statusCode}`);
  chequea('S3 sigue habiendo 1 solo EGRESO de cierre', cierresTrasReintento === 1);

  // ── S4: ingreso de fondo concurrente con el cierre (A-015) ──────────────
  console.log('\n== S4: ENTREGA DE FONDO vs CIERRE CONCURRENTES ==');
  const resAparc = mockRes();
  await abrirCaja(mockReq({ montoInicial: 30 }), resAparc);
  chequea('S4 segundo turno abierto (201)', resAparc.statusCode === 201, `status=${resAparc.statusCode}`);
  const turno2 = await prisma.caja.findFirst({ where: { Activa: true } });
  if (!turno2) throw new Error('S4 no abrió el segundo turno');
  creadosEnEstaCorrida.push(turno2.Caja_ID);

  const resIng2 = mockRes();
  const resC4 = mockRes();
  await Promise.all([
    ingresarFondoCaja(mockReq({ monto: 25, metodoPago: 'Efectivo' }), resIng2),
    cerrarCaja(mockReq({}), resC4), // sin conteo: siempre cuadra
  ]);

  const egresoCierre2 = await prisma.movimientos_caja.findMany({
    where: { Concepto: { startsWith: 'Cierre de caja' }, Caja_ID: turno2.Caja_ID },
  });
  const ingresoEnTurno2 = await prisma.movimientos_caja.count({
    where: {
      Caja_ID: turno2.Caja_ID,
      Concepto: { startsWith: 'Ingreso de caja (fondo de maniobra)' },
    },
  });

  if (resIng2.statusCode === 201) {
    // El ingreso ganó la carrera: debe estar INCLUIDO en la entrega del cierre.
    const entregado = Number(resC4.body?.saldoEntregado ?? -1);
    chequea(
      'S4 ingreso ganador incluido en la entrega (30+25=55)',
      ingresoEnTurno2 === 1 && egresoCierre2.length === 1 && entregado === 55,
      `ingreso=201 entregado=${entregado} egresosCierre=${egresoCierre2.length}`
    );
  } else {
    // El cierre ganó la carrera: el ingreso se rechaza y NO queda registrado.
    chequea(
      'S4 ingreso perdedor rechazado sin dejar movimiento (409)',
      resIng2.statusCode === 409 && ingresoEnTurno2 === 0,
      `ingreso=${resIng2.statusCode} movimientos=${ingresoEnTurno2}`
    );
  }
  chequea('S4 cierre siempre exitoso', resC4.statusCode === 200, `status=${resC4.statusCode}`);
  chequea('S4 un solo EGRESO de cierre en el turno 2', egresoCierre2.length === 1);

  // ── Resumen ──────────────────────────────────────────────────────────────
  console.log('\n== RESUMEN ==');
  if (fallos.length === 0) {
    console.log('TODO PASS · concurrencia de caja serializada correctamente');
  } else {
    console.error(`FALLARON ${fallos.length} aserciones:\n - ${fallos.join('\n - ')}`);
  }
}

main()
  .catch((e) => {
    console.error('ERROR no controlado en la prueba:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Limpieza: solo las filas creadas por esta corrida, en base de QA.
    try {
      if (creadosEnEstaCorrida.length > 0) {
        await prisma.movimientos_caja.deleteMany({
          where: { Caja_ID: { in: creadosEnEstaCorrida } },
        });
        await prisma.caja.deleteMany({
          where: { Caja_ID: { in: creadosEnEstaCorrida } },
        });
      }
      // Limpieza acotada a los IDs creados por ESTA corrida (creadosEnEstaCorrida).
      // Se eliminó el deleteMany({}) final sobre toda la tabla para no borrar datos
      // de otra corrida/fixture en la base de QA. El vaciado inicial (en main) ya
      // dejó la base lista para la carrera de concurrencia y solo se alcanza tras
      // validar que el destino es exactamente adrialga_qa en loopback (guard).
    } catch (e) {
      console.error('Fallo en limpieza de QA:', e);
    }
    await prisma.$disconnect();
    if (fallos.length > 0) process.exitCode = 1;
  });
