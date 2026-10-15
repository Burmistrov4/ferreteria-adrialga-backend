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
  const year = new Date().getFullYear();
  for (const prefijo of ['PIN', 'FER', 'SOL', 'HER', 'HEZ']) {
    const patron = `${prefijo}-${year}-%`;
    const [row] = await p.$queryRaw`SELECT MAX(SKU_Codigo) AS maxSku FROM Productos WHERE SKU_Codigo LIKE ${patron}`;
    const seq = row?.maxSku ? parseInt(row.maxSku.split('-')[2], 10) + 1 : 1;
    console.log(`${prefijo} -> ${prefijo}-${year}-${String(seq).padStart(4, '0')}`);
  }
  await p.$disconnect();
})();