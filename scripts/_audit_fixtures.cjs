// Inspección (solo lectura) de artefactos de QA que quedaron en la base de
// demo `adrialga`: productos/clientes con nombres de fixture que un profesor
// vería en pantalla durante la presentación.
//
// Uso: node scripts/_audit_fixtures.cjs
require('dotenv').config();
const guard = require('./qa_guard.cjs');

// Salvaguarda del proyecto: todo script que CONECTA exige un destino local
// verificado ANTES de crear el cliente (ver qa_guard.cjs).
{
  const v = guard.validarHostLocal(process.env.DATABASE_URL || '');
  if (!v.ok) {
    console.error(`✖ ABORTADO: ${v.error} | destino=${guard.sanitizar(process.env.DATABASE_URL || '')}`);
    process.exit(3);
  }
}

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const PATRONES = ['test', 'e2e', 'humo', 'def', 'prueba', 'qa', 'dummy', 'tmp', 'temp', 'antidef'];

(async () => {
  const productos = await prisma.productos.findMany({
    where: { Activo: true },
    select: { Producto_ID: true, Nombre: true, SKU_Codigo: true, Stock_Actual: true },
  });
  const sospechosos = productos.filter((p) => {
    const n = (p.Nombre ?? '').toLowerCase();
    return PATRONES.some((pat) => n.includes(pat));
  });

  console.log(`Productos ACTIVOS: ${productos.length}`);
  console.log(`Productos con nombre de fixture: ${sospechosos.length}\n`);
  for (const p of sospechosos) {
    console.log(
      `  #${String(p.Producto_ID).padStart(5)}  stock=${String(p.Stock_Actual).padStart(5)}  "${p.Nombre}"`
    );
  }

  // ¿Tienen historial comercial? Un fixture sin ventas ni compras se puede
  // desactivar sin perder trazabilidad contable.
  const ids = sospechosos.map((p) => p.Producto_ID);
  if (ids.length > 0) {
    const conVenta = await prisma.detalle_facturas.groupBy({
      by: ['Producto_ID'],
      where: { Producto_ID: { in: ids } },
      _count: { _all: true },
    });
    const conCompra = await prisma.detalle_notas_entrega.groupBy({
      by: ['Producto_ID'],
      where: { Producto_ID: { in: ids } },
      _count: { _all: true },
    });
    const mapaV = new Map(conVenta.map((r) => [r.Producto_ID, r._count._all]));
    const mapaC = new Map(conCompra.map((r) => [r.Producto_ID, r._count._all]));
    console.log('\nHistorial de los sospechosos:');
    for (const p of sospechosos) {
      console.log(
        `  #${String(p.Producto_ID).padStart(5)}  ventas=${mapaV.get(p.Producto_ID) ?? 0}  compras=${mapaC.get(p.Producto_ID) ?? 0}  "${p.Nombre}"`
      );
    }
  }

  // Clientes con nombres de fixture.
  const clientes = await prisma.clientes.findMany({
    select: { Cliente_ID: true, Razon_Social: true, RIF_Cedula: true },
  });
  const cliSosp = clientes.filter((c) => {
    const n = (c.Razon_Social ?? '').toLowerCase();
    return PATRONES.some((pat) => n.includes(pat));
  });
  console.log(`\nClientes: ${clientes.length} (con nombre de fixture: ${cliSosp.length})`);
  for (const c of cliSosp) console.log(`  #${c.Cliente_ID}  "${c.Razon_Social}"  ${c.RIF_Cedula}`);

  // Proveedores con nombres de fixture.
  const provs = await prisma.proveedores.findMany({
    select: { Proveedor_ID: true, Razon_Social: true },
  });
  const provSosp = provs.filter((p) => {
    const n = (p.Razon_Social ?? '').toLowerCase();
    return PATRONES.some((pat) => n.includes(pat));
  });
  console.log(`\nProveedores: ${provs.length} (con nombre de fixture: ${provSosp.length})`);
  for (const p of provSosp) console.log(`  #${p.Proveedor_ID}  "${p.Razon_Social}"`);

  await prisma.$disconnect();
})().catch(async (e) => {
  console.error('ERROR:', e.message);
  await prisma.$disconnect();
  process.exit(1);
});
