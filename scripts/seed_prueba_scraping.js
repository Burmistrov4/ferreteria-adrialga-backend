const { PrismaClient } = require('@prisma/client');
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
