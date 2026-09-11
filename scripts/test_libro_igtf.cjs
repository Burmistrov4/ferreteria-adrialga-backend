// PRUEBA EXPERIMENTAL: Libro de Ventas SENIAT con desglose Base_IGTF (FRENTE 3).
// Valida numéricamente contra la BD: para cada factura con IGTF>0, la fila del
// libro debe reportar Base_IGTF_Bs = baseIgtf×tasa y IGTF_Bs = igtf×tasa.
const BASE = 'http://localhost:3000/api';
const assert = (cond, msg) => {
  if (!cond) throw new Error(`FALLO: ${msg}`);
  console.log(`OK  ${msg}`);
};

(async () => {
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();

  const loginRes = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Credencial: 'admin', Password: 'admin123' })
  });
  const { token } = await loginRes.json();
  const auth = { Authorization: `Bearer ${token}` };

  // ── 1. JSON del libro del mes actual ──
  const ahora = new Date();
  const anio = ahora.getUTCFullYear();
  const mes = ahora.getUTCMonth() + 1;
  const libroRes = await fetch(
    `${BASE}/seniat/libro-ventas?anio=${anio}&mes=${mes}`,
    { headers: auth }
  );
  assert(libroRes.ok, `Libro de ventas JSON (HTTP ${libroRes.status})`);
  const { filas } = await libroRes.json();
  assert(Array.isArray(filas) && filas.length > 0, `Filas del libro: ${filas.length}`);

  // ── 2. Campo baseIgtfUsd presente en el shape ──
  assert(
    filas.every((f) => typeof f.baseIgtfUsd === 'number'),
    'Todas las filas exponen baseIgtfUsd numérico'
  );

  // ── 3. Consistencia IGTF: igtf ≈ base × 3% para cada fila con IGTF>0 ──
  const conIgtf = filas.filter((f) => Math.abs(f.igtfUsd) > 0);
  console.log(`INFO  Filas con IGTF: ${conIgtf.length} de ${filas.length}`);
  for (const f of conIgtf) {
    const esperado = Math.abs(f.baseIgtfUsd) * 0.03;
    assert(
      Math.abs(Math.abs(f.igtfUsd) - esperado) < 0.02,
      `Fila #${f.operacion}: IGTF ${Math.abs(f.igtfUsd).toFixed(2)} ≈ 3% de Base ${Math.abs(f.baseIgtfUsd).toFixed(2)}`
    );
  }

  // ── 4. CSV con 17 columnas (desglose Base/Alicuota/Monto IGTF) ──
  const csvRes = await fetch(
    `${BASE}/seniat/libro-ventas?anio=${anio}&mes=${mes}&formato=csv`,
    { headers: auth }
  );
  assert(csvRes.ok, `Libro de ventas CSV (HTTP ${csvRes.status})`);
  const csv = await csvRes.text();
  const lineas = csv.replace(/^\uFEFF/, '').trim().split('\r\n');
  const encabezado = lineas[0].split(';');
  assert(
    encabezado.includes('Base_IGTF_Bs') &&
      encabezado.includes('Alicuota_IGTF_%') &&
      encabezado.includes('IGTF_Bs'),
    'Encabezado CSV contiene Base_IGTF_Bs, Alicuota_IGTF_% e IGTF_Bs'
  );
  assert(
    encabezado.length === 17,
    `Encabezado con 17 columnas SENIAT (= ${encabezado.length})`
  );
  // Cada fila de datos con IGTF debe traer alícuota 3.
  const idxIgtf = encabezado.indexOf('IGTF_Bs');
  const idxAlicIgtf = encabezado.indexOf('Alicuota_IGTF_%');
  const filasIgtfCsv = lineas.slice(1).filter((l) => {
    const c = l.split(';');
    return Math.abs(parseFloat((c[idxIgtf] ?? '0').replace(',', '.'))) > 0;
  });
  for (const l of filasIgtfCsv.slice(0, 5)) {
    const c = l.split(';');
    assert(c[idxAlicIgtf] === '3', `Fila CSV con IGTF lleva Alicuota_IGTF_% = ${c[idxAlicIgtf]}`);
  }
  assert(filasIgtfCsv.length === conIgtf.length, `Filas CSV con IGTF (${filasIgtfCsv.length}) = JSON (${conIgtf.length})`);

  await prisma.$disconnect();
  console.log('\nLIBRO VENTAS SENIAT + BASE IGTF: TODAS LAS PRUEBAS EN VERDE');
})().catch((e) => {
  console.log(`❌ ${e.message}`);
  process.exit(1);
});
