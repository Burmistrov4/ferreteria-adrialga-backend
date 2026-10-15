/**
 * test_dashboard_metricas.ts — ADR-T010 · A-018 / A-019.
 *
 * SEGURIDAD: escribe en base de QA desechable (DATABASE_URL_QA). Rechaza si
 * DATABASE_URL_QA es igual a la real. No toca producción.
 *
 * Qué demuestra (contrato de métricas de ventas):
 *  - A-019: los totales de venta (monto, Bs, conteo, ticket) y el ranking por
 *    cajero EXCLUYEN NOTA_CREDITO. Una NC con Total_General negativo no infla
 *    ni el monto ni el conteo ni el ticket promedio.
 *  - A-018: el ranking por cajero entrega `monto` en USD y un nuevo `montoBs`
 *    (USD × tasa histórica por factura), de modo que la UI puede etiquetar cada
 *    uno con su moneda correcta sin ambigüedad.
 *
 * Códigos de salida: 0 = TODO PASS · 1 = fallo · 3 = SKIP.
 */
require('dotenv').config();
const guard = require('../scripts/qa_guard.cjs');

const urlQa = process.env.DATABASE_URL_QA;
const urlReal = process.env.DATABASE_URL;
if (!urlQa) {
  console.error('SKIP: define DATABASE_URL_QA apuntando a adrialga_qa (desechable).');
  process.exit(3);
}
// Salvaguarda (ADR-002/007): validar host loopback + base exacta adrialga_qa +
// que QA no coincida con la real (comparada por host+base, no solo por cadena).
const vQa = guard.validarUrlQa(urlQa, urlReal);
if (!vQa.ok) {
  console.error('ABORTADO:', vQa.error);
  process.exit(vQa.code || 3);
}
console.log('QA destino:', guard.sanitizar(urlQa));
process.env.DATABASE_URL = urlQa;

const { prisma } = require('../src/config/db');
const { getSerieFinanciera, getDashboardMetrics } = require('../src/controllers/dashboard.controllers');

const fallos: string[] = [];
function chequea(nombre: string, ok: boolean, detalle = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} · ${nombre}${detalle ? ` · ${detalle}` : ''}`);
  if (!ok) fallos.push(nombre);
}

const mockRes = () => {
  const r: any = { statusCode: 200, body: undefined };
  r.status = (c: number) => { r.statusCode = c; return r; };
  r.json = (o: any) => { r.body = o; return r; };
  return r;
};
const mockReq = (query: any) => ({ query } as any);

const creados = { clienteId: 0, usuarioId: 0, facturas: [] as number[] };

async function main() {
  const ts = Date.now();
  const cliente = await prisma.clientes.create({
    data: { Razon_Social: `TEST_DASH_CLI_${ts}`, RIF_Cedula: `TEST${ts}` },
  });
  creados.clienteId = cliente.Cliente_ID;
  const usu = await prisma.usuarios.create({
    data: { Nombre: `Test Dash Cajero ${ts}`, Credencial: `test_dash_${ts}`, Password: 'x', Rol: 'CAJERO' },
  });
  creados.usuarioId = usu.Usuario_ID;

  // Dos FACTURA (Bs = USD × 100) y una NOTA_CREDITO negativa del mismo cajero.
  const f1 = await prisma.facturas.create({
    data: {
      Numero_Control: `TESTDASH-F1-${ts}`, Subtotal: 100, Total_IVA: 0, Total_General: 100,
      Tasa_Cambio: 100, Tipo_Documento: 'FACTURA', Cliente_ID: cliente.Cliente_ID, Usuario_ID: usu.Usuario_ID,
    },
  });
  const f2 = await prisma.facturas.create({
    data: {
      Numero_Control: `TESTDASH-F2-${ts}`, Subtotal: 200, Total_IVA: 0, Total_General: 200,
      Tasa_Cambio: 100, Tipo_Documento: 'FACTURA', Cliente_ID: cliente.Cliente_ID, Usuario_ID: usu.Usuario_ID,
    },
  });
  const nc = await prisma.facturas.create({
    data: {
      Numero_Control: `TESTDASH-NC-${ts}`, Subtotal: -50, Total_IVA: 0, Total_General: -50,
      Tasa_Cambio: 100, Tipo_Documento: 'NOTA_CREDITO', Cliente_ID: cliente.Cliente_ID, Usuario_ID: usu.Usuario_ID,
    },
  });
  creados.facturas = [f1.Factura_ID, f2.Factura_ID, nc.Factura_ID];

  // ── getSerieFinanciera (periodo mes incluye el día de hoy) ────────────────
  const res = mockRes();
  await getSerieFinanciera(mockReq({ periodo: 'mes' }), res);
  chequea('getSerieFinanciera 200', res.statusCode === 200, `status=${res.statusCode}`);
  const body = res.body;
  if (!body) throw new Error('getSerieFinanciera no devolvió body');

  const ventas = body.ventas;
  // A-019: el total de ventas excluye la NC (-50). Mínimo = 300 de las dos FACTURA
  // (puede haber otras FACTURA históricas en QA, por eso >=).
  chequea('ventas.montoTotal excluye NC (>=300)', ventas.montoTotal >= 300, `montoTotal=${ventas.montoTotal}`);
  chequea('ventas.cantidadFacturas excluye NC (>=2)', ventas.cantidadFacturas >= 2, `cantidad=${ventas.cantidadFacturas}`);
  // Coherencia interna: ticket = monto / cantidad (aprox, por otras facturas posibles).
  const ticketEsperado = ventas.cantidadFacturas > 0 ? ventas.montoTotal / ventas.cantidadFacturas : 0;
  chequea('ventas.ticketPromedio coherente', Math.abs(ventas.ticketPromedio - ticketEsperado) < 1e-6,
    `ticket=${ventas.ticketPromedio}`);
  // Conversión a Bs con tasa histórica: la prueba EXACTA está en el ranking por
  // cajero (montoBs === 30000 = 300 × 100). A nivel global solo verificamos piso
  // de contribución de nuestras 2 FACTURA (no dependemos de un umbral mágico).
  chequea('ventas.montoTotalBs refleja aporte fixtures', ventas.montoTotalBs >= 300,
    `montoTotalBs=${ventas.montoTotalBs}`);

  // ── Ranking por cajero (A-018 + A-019 en un solo lugar) ───────────────────
  const fila = body.rendimientoCajeros.find((c: any) => Number(c.usuarioId) === usu.Usuario_ID);
  chequea('cajero presente en ranking', !!fila, fila ? `monto=${fila.monto}` : 'ausente');
  if (fila) {
    // A-019: monto del cajero = solo FACTURA (100+200=300), NC(-50) excluida.
    chequea('ranking.monto excluye NC = 300', fila.monto === 300, `monto=${fila.monto}`);
    chequea('ranking.facturas excluye NC = 2', fila.facturas === 2, `facturas=${fila.facturas}`);
    // A-018: monto en USD y montoBs = monto × 100 (tasa histórica ambas facturas).
    chequea('ranking.monto es USD (=300)', fila.monto === 300, `monto=${fila.monto}`);
    chequea('ranking.montoBs = monto × tasa (30000)', fila.montoBs === 30000, `montoBs=${fila.montoBs}`);
    chequea('ranking.ticketPromedio = 150', fila.ticketPromedio === 150, `ticket=${fila.ticketPromedio}`);
    chequea('ranking.ticketPromedioBs = 15000', fila.ticketPromedioBs === 15000, `ticketBs=${fila.ticketPromedioBs}`);
  }

  // ── getDashboardMetrics (global, A-019 en totales globales) ───────────────
  const resG = mockRes();
  await getDashboardMetrics(mockReq({}), resG);
  chequea('getDashboardMetrics 200', resG.statusCode === 200, `status=${resG.statusCode}`);
  const g = resG.body?.resumen;
  if (g) {
    chequea('global.montoTotalVentas excluye NC (>=300)', g.montoTotalVentas >= 300, `monto=${g.montoTotalVentas}`);
    chequea('global.totalFacturas excluye NC (>=2)', g.totalFacturas >= 2, `total=${g.totalFacturas}`);
    chequea('global.montoTotalVentasBs refleja aporte fixtures', g.montoTotalVentasBs >= 300, `bs=${g.montoTotalVentasBs}`);
  } else {
    chequea('global.resumen presente', false);
  }

  console.log('\n== RESUMEN ADR-T010 (A-018/A-019) ==');
  if (fallos.length === 0) console.log('TODO PASS · contrato de métricas de ventas verificado');
  else console.error(`FALLARON ${fallos.length}: ${fallos.join(', ')}`);
}

main()
  .catch((e) => { console.error('ERROR no controlado:', e); process.exitCode = 1; })
  .finally(async () => {
    try {
      if (creados.facturas.length) {
        await prisma.detalle_facturas.deleteMany({ where: { Factura_ID: { in: creados.facturas } } });
        await prisma.facturas.deleteMany({ where: { Factura_ID: { in: creados.facturas } } });
      }
      if (creados.clienteId) await prisma.clientes.deleteMany({ where: { Cliente_ID: creados.clienteId } });
      if (creados.usuarioId) await prisma.usuarios.deleteMany({ where: { Usuario_ID: creados.usuarioId } });
    } catch (e) { console.error('Fallo en limpieza QA:', e); }
    await prisma.$disconnect();
    if (fallos.length > 0) process.exitCode = 1;
  });
