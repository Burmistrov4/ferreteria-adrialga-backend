const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  // Valores esperados del test manual anterior (corregidos):
  await p.productos.update({ where: { Producto_ID: 2 }, data: { Stock_Actual: 20, Costo_Promedio: 8.5 } });
  await p.productos.update({ where: { Producto_ID: 3 }, data: { Stock_Actual: 34, Costo_Promedio: 9.5 } });
  const r = await p.productos.findMany({ where: { Producto_ID: { in: [2, 3] } }, select: { Producto_ID: true, Stock_Actual: true, Costo_Promedio: true } });
  console.log('corregido:', JSON.stringify(r));
  await p.$disconnect();
})();