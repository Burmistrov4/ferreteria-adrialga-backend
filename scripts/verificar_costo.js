const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  const r = await p.productos.findUnique({ where: { SKU_Codigo: 'FER-0042' } });
  console.log('Costo_Promedio DESPUÉS =', String(r?.Costo_Promedio));
  await p.$disconnect();
})();
