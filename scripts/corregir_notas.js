const { PrismaClient } = require('@prisma/client');
const guard = require('./qa_guard.cjs');
{
  if (!process.env.DATABASE_URL) {
    try { require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); } catch {}
  }
  const _guardUrl = process.env.DATABASE_URL || '';
  if (!_guardUrl) {
    console.error('ABORTADO: DATABASE_URL no está definida (ni en entorno ni en .env).');
    process.exit(3);
  }
  const _guardV = guard.validarHostLocal(_guardUrl);
  if (!_guardV.ok) {
    console.error('ABORTADO: destino de base de datos no permitido (' + guard.sanitizar(_guardUrl) + '): ' + _guardV.error);
    process.exit(3);
  }
}
const p = new PrismaClient();

(async () => {
  // Valores esperados del test manual anterior (corregidos):
  await p.productos.update({ where: { Producto_ID: 2 }, data: { Stock_Actual: 20, Costo_Promedio: 8.5 } });
  await p.productos.update({ where: { Producto_ID: 3 }, data: { Stock_Actual: 34, Costo_Promedio: 9.5 } });
  const r = await p.productos.findMany({ where: { Producto_ID: { in: [2, 3] } }, select: { Producto_ID: true, Stock_Actual: true, Costo_Promedio: true } });
  console.log('corregido:', JSON.stringify(r));
  await p.$disconnect();
})();