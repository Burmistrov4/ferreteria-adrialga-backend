/**
 * test_variantes_compra.ts — A-016: trazabilidad de variantes en compras.
 *
 * SEGURIDAD: escribe en base de QA desechable (DATABASE_URL_QA). Rechaza si
 * DATABASE_URL_QA es igual a la real. No toca producción.
 *
 * Qué demuestra:
 *  - Compra CON variante  → el detalle persiste Variante_ID y la variante
 *    incrementa su stock.
 *  - Compra SIN variante  → el detalle persiste Variante_ID = null (no rompe
 *    el histórico de notas antiguas).
 *  - Varias variantes del MISMO producto en una nota → cada detalle guarda la
 *    suya.
 *  - La lectura (getNotasEntrega) expone la variante en el detalle.
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
const { createNotaEntrega, getNotasEntrega } = require('../src/controllers/notas.controllers');

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
const mockReq = (body: any, usuarioId: number) => ({ body, user: { usuarioId, rol: 'CAJERO' } } as any);

// IDs creados para limpieza.
const creados = { categoriaId: 0, productoId: 0, variantes: [] as number[], usuarioId: 0, notaIds: [] as number[] };

async function main() {
  // ── Fixtures mínimos en QA ───────────────────────────────────────────────
  const cat = await prisma.categorias.create({ data: { Nombre: 'TEST_VAR_CAT' } });
  creados.categoriaId = cat.Categoria_ID;
  const prod = await prisma.productos.create({
    data: {
      SKU_Codigo: `TEST_VAR_${Date.now()}`,
      Nombre: 'Producto Test Variantes',
      Categoria_ID: cat.Categoria_ID,
      Stock_Actual: 0,
      Costo_Promedio: 0,
    },
  });
  creados.productoId = prod.Producto_ID;
  const v1 = await prisma.producto_variantes.create({
    data: { Producto_ID: prod.Producto_ID, SKU_Variante: `TEST_VAR_V1_${Date.now()}`, Stock_Actual: 0 },
  });
  const v2 = await prisma.producto_variantes.create({
    data: { Producto_ID: prod.Producto_ID, SKU_Variante: `TEST_VAR_V2_${Date.now()}`, Stock_Actual: 0 },
  });
  creados.variantes = [v1.Variante_ID, v2.Variante_ID];
  const usu = await prisma.usuarios.create({
    data: {
      Nombre: 'Test Variantes',
      Credencial: `test_var_${Date.now()}`,
      Password: 'x',
      Rol: 'CAJERO',
    },
  });
  creados.usuarioId = usu.Usuario_ID;

  // ── Compra mixta: con V1, sin variante, con V2 ──────────────────────────
  const res = mockRes();
  await createNotaEntrega(
    mockReq(
      {
        Numero_Nota: `TEST_VAR_${Date.now()}`,
        Forma_Pago: 'Credito', // evita requerir caja abierta en la prueba
        detalles: [
          { Producto_ID: prod.Producto_ID, Cantidad: 5, Costo_Unitario: 10, Variante_ID: v1.Variante_ID },
          { Producto_ID: prod.Producto_ID, Cantidad: 3, Costo_Unitario: 10 }, // sin variante
          { Producto_ID: prod.Producto_ID, Cantidad: 2, Costo_Unitario: 10, Variante_ID: v2.Variante_ID },
        ],
      },
      usu.Usuario_ID,
    ),
    res,
  );

  chequea('createNotaEntrega devuelve 201', res.statusCode === 201, `status=${res.statusCode}`);
  creados.notaIds.push(res.body?.nota?.Nota_ID ?? res.body?.Nota_ID);
  const notaId = res.body?.nota?.Nota_ID ?? res.body?.Nota_ID;
  if (!notaId) throw new Error('No se obtuvo Nota_ID de la respuesta');

  // ── Persistencia: Variante_ID por detalle ───────────────────────────────
  const detalles = await prisma.detalle_notas_entrega.findMany({
    where: { Nota_ID: notaId },
    orderBy: { Detalle_Nota_ID: 'asc' },
    include: { producto_variantes: true },
  });
  chequea('3 detalles creados', detalles.length === 3, `n=${detalles.length}`);
  const variantesPersistidas = detalles.map((d: any) => d.Variante_ID ?? null);
  chequea(
    'Variantes persistidas = [V1, null, V2]',
    JSON.stringify(variantesPersistidas) === JSON.stringify([v1.Variante_ID, null, v2.Variante_ID]),
    JSON.stringify(variantesPersistidas),
  );

  // ── Stock de variantes actualizado ──────────────────────────────────────
  const v1b = await prisma.producto_variantes.findUnique({ where: { Variante_ID: v1.Variante_ID } });
  const v2b = await prisma.producto_variantes.findUnique({ where: { Variante_ID: v2.Variante_ID } });
  chequea('Stock V1 = 5', v1b!.Stock_Actual === 5, `stock=${v1b!.Stock_Actual}`);
  chequea('Stock V2 = 2', v2b!.Stock_Actual === 2, `stock=${v2b!.Stock_Actual}`);

  // ── Stock del producto padre = suma (10) ────────────────────────────────
  const prodb = await prisma.productos.findUnique({ where: { Producto_ID: prod.Producto_ID } });
  chequea('Stock producto = 10', prodb!.Stock_Actual === 10, `stock=${prodb!.Stock_Actual}`);

  // ── Lectura expone la variante ──────────────────────────────────────────
  const resGet = mockRes();
  await getNotasEntrega(mockReq({}, usu.Usuario_ID), resGet);
  const notasLeidas = resGet.body ?? [];
  const notaLeida = Array.isArray(notasLeidas)
    ? notasLeidas.find((n: any) => n.Nota_ID === notaId)
    : null;
  const detLeidos = notaLeida?.detalle_notas_entrega ?? [];
  const variantesLeidas = detLeidos.map((d: any) => d.producto_variantes?.Variante_ID ?? d.Variante_ID ?? null);
  chequea(
    'Lectura expone variante en detalle',
    detLeidos.length === 3 && JSON.stringify(variantesLeidas) === JSON.stringify([v1.Variante_ID, null, v2.Variante_ID]),
    JSON.stringify(variantesLeidas),
  );

  console.log('\n== RESUMEN A-016 ==');
  if (fallos.length === 0) console.log('TODO PASS · trazabilidad de variantes en compras verificada');
  else console.error(`FALLARON ${fallos.length}: ${fallos.join(', ')}`);
}

main()
  .catch((e) => { console.error('ERROR no controlado:', e); process.exitCode = 1; })
  .finally(async () => {
    try {
      // Limpieza: CxP (por Credito) → detalles → nota → variantes → producto → categoria → usuario.
      if (creados.notaIds.length) {
        await prisma.cuentas_por_pagar.deleteMany({ where: { Nota_ID: { in: creados.notaIds } } });
        await prisma.detalle_notas_entrega.deleteMany({ where: { Nota_ID: { in: creados.notaIds } } });
        await prisma.notas_entrega_entrada.deleteMany({ where: { Nota_ID: { in: creados.notaIds } } });
      }
      if (creados.variantes.length) await prisma.producto_variantes.deleteMany({ where: { Variante_ID: { in: creados.variantes } } });
      if (creados.productoId) await prisma.productos.deleteMany({ where: { Producto_ID: creados.productoId } });
      if (creados.categoriaId) await prisma.categorias.deleteMany({ where: { Categoria_ID: creados.categoriaId } });
      if (creados.usuarioId) await prisma.usuarios.deleteMany({ where: { Usuario_ID: creados.usuarioId } });
    } catch (e) { console.error('Fallo en limpieza QA:', e); }
    await prisma.$disconnect();
    if (fallos.length > 0) process.exitCode = 1;
  });
