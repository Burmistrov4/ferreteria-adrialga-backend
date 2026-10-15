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
  const prodIds = (await p.productos.findMany({ select: { Producto_ID: true } })).map(x => x.Producto_ID);
  const r1 = await p.producto_variantes.deleteMany({ where: { SKU_Variante: { startsWith: 'TEST-V1-' } } });
  console.log('test eliminadas:', r1.count);
  const orfans = await p.producto_variantes.findMany({ where: { productos: { is: { Producto_ID: { notIn: prodIds } } } } });
  // En Prisma "productos: { is: ... }" filtra por relación; verificálas y borra.
  console.log('huérfanas:', orfans.length);
  if (orfans.length > 0) {
    const ids = orfans.map(v => v.Variante_ID);
    const del = await p.producto_variantes.deleteMany({ where: { Variante_ID: { in: ids } } });
    console.log('huérfanas eliminadas:', del.count);
  }
  await p.$disconnect();
})().catch(e => { console.error(e); process.exit(1); });
