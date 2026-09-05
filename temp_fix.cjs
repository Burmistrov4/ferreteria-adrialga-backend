const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  const result = await p.$queryRawUnsafe(
    'UPDATE facturas SET Tasa_Cambio = 1.0 WHERE Tasa_Cambio IS NULL'
  );
  console.log('Rows affected:', result.count);
  await p.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
