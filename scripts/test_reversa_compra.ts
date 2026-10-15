/**
 * test_reversa_compra.ts — A-017: reversa/anulación de notas de entrada.
 *
 * SEGURIDAD: escribe en base de QA desechable (DATABASE_URL_QA). Rechaza si
 * DATABASE_URL_QA es igual a la real. No toca producción.
 *
 * Escenarios validados:
 *  S1 Limpio (Crédito, CxP Pendiente): reversa → 200; nota Anulada; stock y
 *     CMP del producto revertidos; CxP anulada (Saldo=0); idempotente (2ª → 409).
 *  S2 Autorización: rol CAJERO → 403; la nota permanece Procesada.
 *  S3 Parcialmente consumido: simula mercancía vendida (stock < recibido) → 409
 *     PARCIAL_CONSUMIDO y NO altera stock ni nota.
 *  S4 CxP con abonos: la cuenta por pagar tiene Monto_Pagado > 0 → 409
 *     CXP_CON_PAGOS; nota, stock y CxP quedan intactos.
 *
 * Códigos de salida: 0 = TODO PASS · 1 = fallo · 3 = SKIP.
 */
require('dotenv').config();

const urlQa = process.env.DATABASE_URL_QA;
const urlReal = process.env.DATABASE_URL;
if (!urlQa) {
  console.error('SKIP: define DATABASE_URL_QA apuntando a adrialga_qa (desechable).');
  process.exit(3);
}
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
const { createNotaEntrega, reverseNotaEntrega } = require('../src/controllers/notas.controllers');

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
const mockReq = (opts: { body?: any; usuarioId: number; rol: string; id?: number }) =>
  ({ body: opts.body ?? {}, user: { usuarioId: opts.usuarioId, rol: opts.rol }, params: { id: String(opts.id) } } as any);

// IDs creados para limpieza.
const creados = {
  cats: [] as number[],
  prods: [] as number[],
  users: [] as number[],
  notas: [] as number[],
};

async function crearNotaCredito(prodId: number, usuarioId: number, qty: number, costo: number) {
  const res = mockRes();
  await createNotaEntrega(
    mockReq({ body: {
      Numero_Nota: `TEST_REV_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
      Forma_Pago: 'Credito',
      detalles: [{ Producto_ID: prodId, Cantidad: qty, Costo_Unitario: costo }],
    }, usuarioId, rol: 'ADMIN' }),
    res,
  );
  const notaId = res.body?.nota?.Nota_ID;
  if (notaId) creados.notas.push(notaId);
  return { res, notaId };
}

async function main() {
  // ── Fixtures mínimos en QA ───────────────────────────────────────────────
  const cat = await prisma.categorias.create({ data: { Nombre: 'TEST_REV_CAT' } });
  creados.cats.push(cat.Categoria_ID);
  const prod = await prisma.productos.create({
    data: { SKU_Codigo: `TEST_REV_${Date.now()}`, Nombre: 'Prod Reversa', Categoria_ID: cat.Categoria_ID, Stock_Actual: 0, Costo_Promedio: 0 },
  });
  creados.prods.push(prod.Producto_ID);
  const admin = await prisma.usuarios.create({
    data: { Nombre: 'Admin Reversa', Credencial: `test_rev_${Date.now()}`, Password: 'x', Rol: 'ADMIN' },
  });
  creados.users.push(admin.Usuario_ID);

  // ===== S1: reversa limpia (Crédito, CxP Pendiente) =====
  const { notaId: n1 } = await crearNotaCredito(prod.Producto_ID, admin.Usuario_ID, 5, 10);
  chequea('S1 · nota creada (201)', !!n1, `notaId=${n1}`);

  const resRev = mockRes();
  await reverseNotaEntrega(mockReq({ usuarioId: admin.Usuario_ID, rol: 'ADMIN', id: n1, body: { motivo: 'Prueba A-017' } }), resRev);
  chequea('S1 · reversa devuelve 200', resRev.statusCode === 200, `status=${resRev.statusCode}`);

  const nota1 = await prisma.notas_entrega_entrada.findUnique({ where: { Nota_ID: n1 } });
  chequea('S1 · nota marcada Anulada', nota1?.Estatus === 'Anulada', `estatus=${nota1?.Estatus}`);
  chequea('S1 · Anulada_Por = admin', nota1?.Anulada_Por === admin.Usuario_ID, `anuladaPor=${nota1?.Anulada_Por}`);
  chequea('S1 · motivo conservado', (nota1?.Motivo_Anulacion ?? '') === 'Prueba A-017');

  const prod1 = await prisma.productos.findUnique({ where: { Producto_ID: prod.Producto_ID } });
  chequea('S1 · stock producto revertido a 0', prod1?.Stock_Actual === 0, `stock=${prod1?.Stock_Actual}`);
  chequea('S1 · CMP revertido a 0', Number(prod1?.Costo_Promedio) === 0, `cpp=${prod1?.Costo_Promedio}`);

  const cxp1 = await prisma.cuentas_por_pagar.findUnique({ where: { Nota_ID: n1 } });
  chequea('S1 · CxP anulada', cxp1?.Estatus === 'Anulada', `estatus=${cxp1?.Estatus}`);
  chequea('S1 · CxP saldo 0', Number(cxp1?.Saldo) === 0, `saldo=${cxp1?.Saldo}`);

  // Idempotencia: segunda reversa → 409 YA_ANULADA
  const resRev2 = mockRes();
  await reverseNotaEntrega(mockReq({ usuarioId: admin.Usuario_ID, rol: 'ADMIN', id: n1 }), resRev2);
  chequea('S1 · idempotente → 409 YA_ANULADA', resRev2.statusCode === 409 && resRev2.body?.tipo === 'YA_ANULADA', `status=${resRev2.statusCode} tipo=${resRev2.body?.tipo}`);

  // ===== S2: autorización (CAJERO bloqueado) =====
  const { notaId: n2 } = await crearNotaCredito(prod.Producto_ID, admin.Usuario_ID, 3, 10);
  const resCajero = mockRes();
  await reverseNotaEntrega(mockReq({ usuarioId: 99999, rol: 'CAJERO', id: n2, body: { motivo: 'x' } }), resCajero);
  chequea('S2 · CAJERO → 403', resCajero.statusCode === 403 && resCajero.body?.tipo === 'PERMISO_INSUFICIENTE', `status=${resCajero.statusCode} tipo=${resCajero.body?.tipo}`);
  const nota2 = await prisma.notas_entrega_entrada.findUnique({ where: { Nota_ID: n2 } });
  chequea('S2 · nota sigue Procesada', nota2?.Estatus === 'Procesada', `estatus=${nota2?.Estatus}`);
  // Limpiar la nota de S2 reversiblemente (ADMIN) para no dejar basura.
  const resRevN2 = mockRes();
  await reverseNotaEntrega(mockReq({ usuarioId: admin.Usuario_ID, rol: 'ADMIN', id: n2 }), resRevN2);
  chequea('S2 · ADMIN anula nota de prueba', resRevN2.statusCode === 200, `status=${resRevN2.statusCode}`);

  // ===== S3: parcialmente consumido → 409 PARCIAL_CONSUMIDO =====
  const prod3 = await prisma.productos.create({
    data: { SKU_Codigo: `TEST_REV3_${Date.now()}`, Nombre: 'Prod Reversa 3', Categoria_ID: cat.Categoria_ID, Stock_Actual: 0, Costo_Promedio: 0 },
  });
  creados.prods.push(prod3.Producto_ID);
  const { notaId: n3 } = await crearNotaCredito(prod3.Producto_ID, admin.Usuario_ID, 5, 10);
  // Simula que 3 unidades ya se vendieron/consumieron: stock queda en 2 (< 5).
  await prisma.productos.update({ where: { Producto_ID: prod3.Producto_ID }, data: { Stock_Actual: 2 } });
  const resParcial = mockRes();
  await reverseNotaEntrega(mockReq({ usuarioId: admin.Usuario_ID, rol: 'ADMIN', id: n3 }), resParcial);
  chequea('S3 · parcialmente consumido → 409 PARCIAL_CONSUMIDO', resParcial.statusCode === 409 && resParcial.body?.tipo === 'PARCIAL_CONSUMIDO', `status=${resParcial.statusCode} tipo=${resParcial.body?.tipo}`);
  const nota3 = await prisma.notas_entrega_entrada.findUnique({ where: { Nota_ID: n3 } });
  chequea('S3 · nota NO alterada (sigue Procesada)', nota3?.Estatus === 'Procesada', `estatus=${nota3?.Estatus}`);
  const prod3b = await prisma.productos.findUnique({ where: { Producto_ID: prod3.Producto_ID } });
  chequea('S3 · stock NO alterado (=2)', prod3b?.Stock_Actual === 2, `stock=${prod3b?.Stock_Actual}`);

  // ===== S4: CxP con abonos → 409 CXP_CON_PAGOS y estado intacto =====
  const { notaId: n4 } = await crearNotaCredito(prod.Producto_ID, admin.Usuario_ID, 5, 10);
  chequea('S4 · nota a crédito creada (201)', !!n4, `notaId=${n4}`);
  // Simula que la cuenta por pagar recibió un abono (Monto_Pagado > 0).
  await prisma.cuentas_por_pagar.update({
    where: { Nota_ID: n4 },
    data: { Monto_Pagado: 10, Saldo: 40 }, // total 50, abono 10, saldo 40
  });
  const resCxpPagos = mockRes();
  await reverseNotaEntrega(mockReq({ usuarioId: admin.Usuario_ID, rol: 'ADMIN', id: n4 }), resCxpPagos);
  chequea(
    'S4 · CxP con abonos → 409 CXP_CON_PAGOS',
    resCxpPagos.statusCode === 409 && resCxpPagos.body?.tipo === 'CXP_CON_PAGOS',
    `status=${resCxpPagos.statusCode} tipo=${resCxpPagos.body?.tipo}`,
  );
  const nota4 = await prisma.notas_entrega_entrada.findUnique({ where: { Nota_ID: n4 } });
  chequea('S4 · nota NO alterada (sigue Procesada)', nota4?.Estatus === 'Procesada', `estatus=${nota4?.Estatus}`);
  const cxp4 = await prisma.cuentas_por_pagar.findUnique({ where: { Nota_ID: n4 } });
  chequea(
    'S4 · CxP intacta tras rechazo (saldo=40, pagado=10)',
    Number(cxp4?.Saldo) === 40 && Number(cxp4?.Monto_Pagado) === 10 && cxp4?.Estatus !== 'Anulada',
    `saldo=${cxp4?.Saldo} pagado=${cxp4?.Monto_Pagado} estatus=${cxp4?.Estatus}`,
  );

  console.log('\n== RESUMEN A-017 ==');
  if (fallos.length === 0) console.log('TODO PASS · reversa de notas de entrada verificada (caso limpio + guardianes)');
  else console.error(`FALLARON ${fallos.length}: ${fallos.join(', ')}`);
}

main()
  .catch((e) => { console.error('ERROR no controlado:', e); process.exitCode = 1; })
  .finally(async () => {
    try {
      // Limpieza QA: CxP → detalles → notas → productos → categorías → usuarios.
      if (creados.notas.length) {
        await prisma.cuentas_por_pagar.deleteMany({ where: { Nota_ID: { in: creados.notas } } });
        await prisma.detalle_notas_entrega.deleteMany({ where: { Nota_ID: { in: creados.notas } } });
        await prisma.notas_entrega_entrada.deleteMany({ where: { Nota_ID: { in: creados.notas } } });
      }
      if (creados.prods.length) await prisma.productos.deleteMany({ where: { Producto_ID: { in: creados.prods } } });
      if (creados.cats.length) await prisma.categorias.deleteMany({ where: { Categoria_ID: { in: creados.cats } } });
      if (creados.users.length) await prisma.usuarios.deleteMany({ where: { Usuario_ID: { in: creados.users } } });
    } catch (e) { console.error('Fallo en limpieza QA:', e); }
    await prisma.$disconnect();
    if (fallos.length > 0) process.exitCode = 1;
  });
