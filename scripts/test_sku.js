const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

(async () => {
  const year = new Date().getFullYear();
  for (const prefijo of ['PIN', 'FER', 'SOL', 'HER', 'HEZ']) {
    const patron = `${prefijo}-${year}-%`;
    const [row] = await p.$queryRaw`SELECT MAX(SKU_Codigo) AS maxSku FROM Productos WHERE SKU_Codigo LIKE ${patron}`;
    const seq = row?.maxSku ? parseInt(row.maxSku.split('-')[2], 10) + 1 : 1;
    console.log(`${prefijo} -> ${prefijo}-${year}-${String(seq).padStart(4, '0')}`);
  }
  await p.$disconnect();
})();