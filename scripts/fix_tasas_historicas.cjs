// scripts/fix_tasas_historicas.cjs
// Sanea las facturas con Tasa_Cambio anómalas (placeholder 1.0, valores legados
// como 35.5, o NULL) y las actualiza a la tasa BCV vigente más reciente
// (última fila de tasas_bcv; fallback: última factura con tasa razonable > 100).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // 1. Tasa correcta: última tasa oficial persistida.
  let correcta = null;
  const ultTasa = await prisma.tasas_bcv.findFirst({ orderBy: { Fecha: 'desc' } });
  if (ultTasa && Number(ultTasa.Tasa) > 1) correcta = Number(ultTasa.Tasa);

  // 2. Fallback: última factura con tasa razonable (> 100 Bs/$).
  if (correcta == null) {
    const ultFact = await prisma.facturas.findFirst({
      where: { Tasa_Cambio: { gt: 100 } },
      orderBy: { Fecha_Emision: 'desc' },
      select: { Tasa_Cambio: true }
    });
    if (ultFact && Number(ultFact.Tasa_Cambio) > 1) correcta = Number(ultFact.Tasa_Cambio);
  }

  if (correcta == null) {
    console.log('No se encontró una tasa BCV de referencia. Nada que hacer.');
    return;
  }

  // 3. Identificar anómalas: < 100 (placeholder 1.0 / legado 35.5).
  const anomalas = await prisma.facturas.findMany({
    where: { Tasa_Cambio: { lt: 100 } },
    select: { Factura_ID: true, Numero_Control: true, Tasa_Cambio: true }
  });

  if (anomalas.length === 0) {
    console.log('No hay facturas con tasa anómala.');
    return;
  }

  const ids = anomalas.map((f) => f.Factura_ID);
  const res = await prisma.facturas.updateMany({
    where: { Factura_ID: { in: ids } },
    data: { Tasa_Cambio: correcta }
  });

  console.log(`Tasa de referencia: ${correcta}`);
  console.log(`Facturas corregidas: ${res.count}`);
  for (const f of anomalas.slice(0, 10)) {
    console.log(`  F-${f.Factura_ID} ${f.Numero_Control ?? ''} (era ${f.Tasa_Cambio})`);
  }
  if (anomalas.length > 10) console.log(`  ... y ${anomalas.length - 10} más`);
}

main()
  .catch((e) => { console.error('FALLO:', e?.message || e); process.exit(1); })
  .finally(() => prisma.$disconnect());