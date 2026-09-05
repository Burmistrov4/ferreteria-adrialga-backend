const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  const r = await p.productos.findMany({
    where: { Producto_ID: { in: [1, 2] } },
    select: { Producto_ID: true, Nombre: true, Stock_Actual: true, Costo_Promedio: true },
  });
  console.log(JSON.stringify(r, null, 1));
  await p.$disconnect();
})();