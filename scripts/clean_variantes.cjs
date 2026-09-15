const { PrismaClient } = require('@prisma/client');
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
