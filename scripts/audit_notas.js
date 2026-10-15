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
  const prods = await p.productos.findMany({ where: { Activo: true }, select: { Producto_ID: true, Nombre: true, Stock_Actual: true, Costo_Promedio: true }, orderBy: { Producto_ID: 'asc' }, take: 5 });
  console.log(JSON.stringify(prods));
  const inf = await p.proveedores.findUnique({ where: { RIF_Cedula: 'J-000000000' } });
  console.log('informal:', inf ? `${inf.Proveedor_ID} - ${inf.Razon_Social}` : 'no existe');
  await p.$disconnect();
})();