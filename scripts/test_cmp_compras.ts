/**
 * test_cmp_compras.ts — T4 / ADR-T006: costo promedio ponderado (CMP) reproducible.
 *
 * SEGURIDAD: escribe en base de QA desechable (DATABASE_URL_QA). Rechaza si
 * DATABASE_URL_QA es igual a la real. No toca producción.
 *
 * Casos reconciliados:
 *  C1 stock 0  + compra costo 5      → CMP=5, stock 10, último=5, precio(50%)=7.5
 *  C2 stock 10 + compra costo 7      → CMP=6 ((50+70)/20), stock 20, último=7, precio=9
 *  C3 stock 20 + compra SIN costo    → CMP se MANTIENE en 6 (NO diluye), stock 25, total=qty*6
 *  C4 stock 0  + compra costo 3.3333 → CMP=3.3333 (redondeo D4 exacto)
 *
 * Códigos de salida: 0 = TODO PASS · 1 = fallo · 3 = SKIP.
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
const { createNotaEntrega } = require('../src/controllers/notas.controllers');

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
const mockReq = (body: any, usuarioId: number) => ({ body, user: { usuarioId, rol: 'ADMIN' } } as any);

const creados = { cats: [] as number[], prods: [] as number[], users: [] as number[], notas: [] as number[] };

async function comprar(prodId: number, usuarioId: number, qty: number, costo?: number) {
  const body: any = {
    Numero_Nota: `TEST_CMP_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
    Forma_Pago: 'Credito',
    detalles: [{ Producto_ID: prodId, Cantidad: qty, ...(costo !== undefined ? { Costo_Unitario: costo } : {}) }],
  };
  const res = mockRes();
  await createNotaEntrega(mockReq(body, usuarioId), res);
  const notaId = res.body?.nota?.Nota_ID;
  if (notaId) creados.notas.push(notaId);
  return { status: res.statusCode, notaId };
}

async function main() {
  const cat = await prisma.categorias.create({ data: { Nombre: 'TEST_CMP_CAT' } });
  creados.cats.push(cat.Categoria_ID);
  const usu = await prisma.usuarios.create({ data: { Nombre: 'Test CMP', Credencial: `test_cmp_${Date.now()}`, Password: 'x', Rol: 'ADMIN' } });
  creados.users.push(usu.Usuario_ID);
  // Margen 50% para validar precio derivado.
  const prod = await prisma.productos.create({
    data: { SKU_Codigo: `TEST_CMP_${Date.now()}`, Nombre: 'Prod CMP', Categoria_ID: cat.Categoria_ID, Stock_Actual: 0, Costo_Promedio: 0, Margen_Ganancia: 50 },
  });
  creados.prods.push(prod.Producto_ID);

  // C1: stock 0, costo 5
  const c1 = await comprar(prod.Producto_ID, usu.Usuario_ID, 10, 5);
  chequea('C1 · nota 201', c1.status === 201, `status=${c1.status}`);
  let p = await prisma.productos.findUnique({ where: { Producto_ID: prod.Producto_ID } });
  chequea('C1 · stock=10', p!.Stock_Actual === 10, `stock=${p!.Stock_Actual}`);
  chequea('C1 · CMP=5', eq(Number(p!.Costo_Promedio), 5), `cmp=${p!.Costo_Promedio}`);
  chequea('C1 · Costo_Ultimo=5', eq(Number(p!.Costo_Ultimo), 5), `ultimo=${p!.Costo_Ultimo}`);
  chequea('C1 · Precio=7.5 (margen 50%)', eq(Number(p!.Precio_Venta), 7.5), `precio=${p!.Precio_Venta}`);

  // C2: stock 10 (cmp5), compra 10 a costo 7 → ((10*5)+(10*7))/20 = 6
  const c2 = await comprar(prod.Producto_ID, usu.Usuario_ID, 10, 7);
  chequea('C2 · nota 201', c2.status === 201, `status=${c2.status}`);
  p = await prisma.productos.findUnique({ where: { Producto_ID: prod.Producto_ID } });
  chequea('C2 · stock=20', p!.Stock_Actual === 20, `stock=${p!.Stock_Actual}`);
  chequea('C2 · CMP=6 (promedio ponderado)', eq(Number(p!.Costo_Promedio), 6), `cmp=${p!.Costo_Promedio}`);
  chequea('C2 · Costo_Ultimo=7', eq(Number(p!.Costo_Ultimo), 7), `ultimo=${p!.Costo_Ultimo}`);
  chequea('C2 · Precio=9 (6×1.5)', eq(Number(p!.Precio_Venta), 9), `precio=${p!.Precio_Venta}`);

  // C3: compra SIN costo → CMP se mantiene en 6 (NO diluye el promedio)
  const c3 = await comprar(prod.Producto_ID, usu.Usuario_ID, 5); // sin Costo_Unitario
  chequea('C3 · nota 201', c3.status === 201, `status=${c3.status}`);
  p = await prisma.productos.findUnique({ where: { Producto_ID: prod.Producto_ID } });
  chequea('C3 · stock=25', p!.Stock_Actual === 25, `stock=${p!.Stock_Actual}`);
  chequea('C3 · CMP se MANTIENE en 6 (sin diluir)', eq(Number(p!.Costo_Promedio), 6), `cmp=${p!.Costo_Promedio}`);
  chequea('C3 · Costo_Ultimo se MANTIENE en 7', eq(Number(p!.Costo_Ultimo), 7), `ultimo=${p!.Costo_Ultimo}`);
  // El detalle de C3 debe haberse registrado con el CMP vigente (6), no con 0.
  const detC3 = await prisma.detalle_notas_entrega.findFirst({ where: { Nota_ID: c3.notaId } });
  chequea('C3 · detalle usa CMP vigente (6)', eq(Number(detC3!.Costo_Unitario), 6), `detCosto=${detC3!.Costo_Unitario}`);

  // C4: nuevo producto stock 0, costo con decimales 3.3333 → CMP=3.3333 (D4 exacto)
  const prod4 = await prisma.productos.create({
    data: { SKU_Codigo: `TEST_CMP4_${Date.now()}`, Nombre: 'Prod CMP4', Categoria_ID: cat.Categoria_ID, Stock_Actual: 0, Costo_Promedio: 0, Margen_Ganancia: 0 },
  });
  creados.prods.push(prod4.Producto_ID);
  const c4 = await comprar(prod4.Producto_ID, usu.Usuario_ID, 3, 3.3333);
  chequea('C4 · nota 201', c4.status === 201, `status=${c4.status}`);
  const p4 = await prisma.productos.findUnique({ where: { Producto_ID: prod4.Producto_ID } });
  chequea('C4 · stock=3', p4!.Stock_Actual === 3, `stock=${p4!.Stock_Actual}`);
  chequea('C4 · CMP=3.3333 (redondeo D4)', eq(Number(p4!.Costo_Promedio), 3.3333, 1e-4), `cmp=${p4!.Costo_Promedio}`);

  console.log('\n== RESUMEN T4 (CMP) ==');
  if (fallos.length === 0) console.log('TODO PASS · costo promedio ponderado reconciliado (explícito, implícito, cero, D4)');
  else console.error(`FALLARON ${fallos.length}: ${fallos.join(', ')}`);
}

main()
  .catch((e) => { console.error('ERROR no controlado:', e); process.exitCode = 1; })
  .finally(async () => {
    try {
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
