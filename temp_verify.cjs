const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  const nullCount = await p.$queryRawUnsafe(
    'SELECT COUNT(*) as cnt FROM facturas WHERE Tasa_Cambio IS NULL'
  );
  console.log('NULL values remaining:', JSON.stringify(nullCount));
  await p.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
