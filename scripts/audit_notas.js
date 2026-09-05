const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  const prods = await p.productos.findMany({ where: { Activo: true }, select: { Producto_ID: true, Nombre: true, Stock_Actual: true, Costo_Promedio: true }, orderBy: { Producto_ID: 'asc' }, take: 5 });
  console.log(JSON.stringify(prods));
  const inf = await p.proveedores.findUnique({ where: { RIF_Cedula: 'J-000000000' } });
  console.log('informal:', inf ? `${inf.Proveedor_ID} - ${inf.Razon_Social}` : 'no existe');
  await p.$disconnect();
})();