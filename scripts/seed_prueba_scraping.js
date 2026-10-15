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
  const r = await p.productos.upsert({
    where: { SKU_Codigo: 'FER-0042' },
    update: { Costo_Promedio: 1.23 },
    create: {
      SKU_Codigo: 'FER-0042',
      Nombre: 'Martillo 16oz mango fibra (prueba scraping)',
      Precio_Venta: 15,
      Costo_Promedio: 1.23,
      Stock_Actual: 10,
      Stock_Minimo: 5,
      Categoria_ID: 1,
    },
  });
  console.log('Producto listo. Costo_Promedio ANTES =', String(r.Costo_Promedio));
  await p.$disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
