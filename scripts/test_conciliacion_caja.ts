/**
 * test_conciliacion_caja.ts — T6 / ADR-T006: conciliación de caja multi-canal.
 *
 * SEGURIDAD: escribe en base de QA desechable (DATABASE_URL_QA). Rechaza si
 * DATABASE_URL_QA es igual a la real. No toca producción.
 *
 * Valida la fórmula por balance (getHistoricoArqueos):
 *   saldoEsperado = Saldo_Inicial + Σ INGRESO efectivo (excl. "Apertura de caja")
 *                   − Σ EGRESO efectivo operativo
 *   saldoEntregado = Σ EGRESO "Cierre de caja" (efectivo)
 *   diferencia = saldoEsperado − saldoEntregado
 *   estadoArqueo = MATCH / DEFICIT / SURPLUS
 * Los pagos DIGITALES (Zelle, Pago Móvil, Transferencia) NO entran al arqueo.
 *
 * Códigos: 0 = TODO PASS · 1 = fallo · 3 = SKIP.
 */
require('dotenv').config();

const urlQa = process.env.DATABASE_URL_QA;
const urlReal = process.env.DATABASE_URL;
if (!urlQa) { console.error('SKIP: define DATABASE_URL_QA apuntando a adrialga_qa.'); process.exit(3); }
// eslint-disable-next-line @typescript-eslint/no-var-requires
const guard = require('./qa_guard.cjs');
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

const { prisma } = require('../src/config/db');
const { getHistoricoArqueos } = require('../src/controllers/caja.controllers');

const fallos: string[] = [];
function chequea(nombre: string, ok: boolean, detalle = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} · ${nombre}${detalle ? ` · ${detalle}` : ''}`);
  if (!ok) fallos.push(nombre);
}
const eq = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

const mockRes = () => {
  const r: any = { statusCode: 200, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (o: any) => { r.body = o; return r; };
  return r;
};
const mockReq = (query: any) => ({ query } as any);

const creados = { users: [] as number[], cajas: [] as number[] };

async function crearTurno(saldoInicial: number) {
  const c = await prisma.caja.create({
    data: {
      Nombre: `TEST_CONC_${Date.now()}`,
      Saldo_Inicial: saldoInicial,
      Saldo_Actual: saldoInicial,
      Estado: 'CERRADA',
      Fecha_Apertura: new Date(),
      Fecha_Cierre: new Date(),
      Activa: false,
      Usuario_ID: creados.users[0],
    },
  });
  creados.cajas.push(c.Caja_ID);
  return c.Caja_ID;
}
async function mover(cajaId: number, tipo: string, concepto: string, metodo: string, monto: number) {
  await prisma.movimientos_caja.create({
    data: { Caja_ID: cajaId, Tipo: tipo, Concepto: concepto, Metodo_Pago: metodo, Monto_USD: monto, Usuario_ID: creados.users[0] },
  });
}

async function main() {
  const now = new Date();
  const anio = now.getUTCFullYear();
  const mes = now.getUTCMonth() + 1;
  const usu = await prisma.usuarios.create({ data: { Nombre: 'Test Conc', Credencial: `test_conc_${Date.now()}`, Password: 'x', Rol: 'CAJERO' } });
  creados.users.push(usu.Usuario_ID);

  // ── Turno 1: mixto con digitales y apertura ───────────────────────────────
  const c1 = await crearTurno(100);
  await mover(c1, 'INGRESO', 'Apertura de caja', 'Efectivo', 100);      // excluido (apertura)
  await mover(c1, 'INGRESO', 'Venta contado', 'Efectivo USD', 50);      // cuenta (efectivo)
  await mover(c1, 'INGRESO', 'Venta Zelle', 'Zelle', 30);              // NO cuenta (digital)
  await mover(c1, 'INGRESO', 'Venta Pago Móvil', 'Pago Móvil', 20);    // NO cuenta (digital)
  await mover(c1, 'EGRESO', 'Compra proveedor', 'Efectivo', 20);       // cuenta egreso
  await mover(c1, 'EGRESO', 'Reembolso banco', 'Transferencia', 10);   // NO cuenta (digital)
  await mover(c1, 'EGRESO', 'Cierre de caja (arqueo)', 'Efectivo', 130); // saldo entregado

  // ── Turno 2: faltante (entregó menos de lo esperado) ──────────────────────
  const c2 = await crearTurno(0);
  await mover(c2, 'INGRESO', 'Apertura de caja', 'Efectivo', 0);
  await mover(c2, 'INGRESO', 'Venta contado', 'Efectivo USD', 100);     // ingreso efectivo
  await mover(c2, 'EGRESO', 'Cierre de caja (arqueo)', 'Efectivo', 90); // entregó 90 de 100

  const res = mockRes();
  await getHistoricoArqueos(mockReq({ anio: String(anio), mes: String(mes) }), res);
  chequea('getHistoricoArqueos 200', res.statusCode === 200, `status=${res.statusCode}`);
  const filas: any[] = res.body?.filas ?? [];
  const f1 = filas.find((f) => f.turnoId === c1);
  const f2 = filas.find((f) => f.turnoId === c2);
  chequea('T1 encontrado', !!f1, `turno=${c1}`);
  if (f1) {
    chequea('T1 · ingresos efectivo = 50 (excluye apertura y digitales)', eq(f1.ingresos, 50), `ingresos=${f1.ingresos}`);
    chequea('T1 · egresos operativos efectivo = 20', eq(f1.egresosOperativos, 20), `egresos=${f1.egresosOperativos}`);
    chequea('T1 · saldoEsperado = 130 (100+50-20)', eq(f1.saldoEsperado, 130), `esperado=${f1.saldoEsperado}`);
    chequea('T1 · saldoEntregado = 130', eq(f1.saldoEntregado, 130), `entregado=${f1.saldoEntregado}`);
    chequea('T1 · diferencia = 0', eq(f1.diferencia, 0), `dif=${f1.diferencia}`);
    chequea('T1 · estadoArqueo = MATCH', f1.estadoArqueo === 'MATCH', `estado=${f1.estadoArqueo}`);
  }
  chequea('T2 encontrado', !!f2, `turno=${c2}`);
  if (f2) {
    chequea('T2 · saldoEsperado = 100', eq(f2.saldoEsperado, 100), `esperado=${f2.saldoEsperado}`);
    chequea('T2 · saldoEntregado = 90', eq(f2.saldoEntregado, 90), `entregado=${f2.saldoEntregado}`);
    chequea('T2 · diferencia = 10 (faltante)', eq(f2.diferencia, 10), `dif=${f2.diferencia}`);
    chequea('T2 · estadoArqueo = DEFICIT', f2.estadoArqueo === 'DEFICIT', `estado=${f2.estadoArqueo}`);
  }

  console.log('\n== RESUMEN T6 (conciliación caja) ==');
  if (fallos.length === 0) console.log('TODO PASS · conciliación multi-canal verificada (digital excluido, apertura excluida, MATCH/DEFICIT)');
  else console.error(`FALLARON ${fallos.length}: ${fallos.join(', ')}`);
}

main()
  .catch((e) => { console.error('ERROR no controlado:', e); process.exitCode = 1; })
  .finally(async () => {
    try {
      if (creados.cajas.length) {
        await prisma.movimientos_caja.deleteMany({ where: { Caja_ID: { in: creados.cajas } } });
        await prisma.caja.deleteMany({ where: { Caja_ID: { in: creados.cajas } } });
      }
      if (creados.users.length) await prisma.usuarios.deleteMany({ where: { Usuario_ID: { in: creados.users } } });
    } catch (e) { console.error('Fallo en limpieza QA:', e); }
    await prisma.$disconnect();
    if (fallos.length > 0) process.exitCode = 1;
  });
