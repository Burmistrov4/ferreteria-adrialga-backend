// Verificación del motor decimal.js del endpoint /api/pagos/procesar
// Casos límite del mandato: IGTF aislado a divisas, precisión 6 dec.
const BASE = 'http://localhost:3000/api';

const assert = (cond, msg) => {
  if (!cond) throw new Error(`FALLO: ${msg}`);
  console.log(`OK  ${msg}`);
};

async function login() {
  const r = await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ Credencial: 'admin', Password: 'admin123' })
  });
  const { token } = await r.json();
  return token;
}

(async () => {
  const token = await login();
  const post = (body) =>
    fetch(`${BASE}/pagos/procesar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body)
    }).then((r) => r.json());

  // ── Caso 1 (mandato literal): $100 → $50 divisa + $50 en Bs. IGTF SOLO sobre 50 ──
  const c1 = await post({
    totalUSD: 100, tasaBCV: 820.1018, efectivoUSD: 50, efectivoVES: 41005.09
  });
  const numEq = (a, b, tol = 1e-9) => Math.abs(parseFloat(a) - b) <= tol;
  assert(numEq(c1.fiscal?.baseIGTFUSD, 50), `C1 base IGTF = ${c1.fiscal?.baseIGTFUSD} (solo divisa)`);
  assert(numEq(c1.fiscal?.igtfUSD, 1.5), `C1 IGTF 3% de 50 = ${c1.fiscal?.igtfUSD}`);
  assert(numEq(c1.fiscal?.cargoTotalUSD, 101.5), `C1 cargo total = ${c1.fiscal?.cargoTotalUSD}`);
  // El cliente pagó 100 exactos: el IGTF (1.5) queda como falta exigible.
  assert(numEq(c1.resultado?.faltaUSD, 1.5, 0.001),
    `C1 falta = IGTF exigido (${c1.resultado?.faltaUSD} USD)`);
  assert(c1.resultado?.pagoCompleto === false, 'C1 sin cubrir IGTF → pago incompleto');
  const c1b = await post({
    totalUSD: 100, tasaBCV: 820.1018, efectivoUSD: 51.5, efectivoVES: 41005.09
  });
  assert(c1b.resultado?.pagoCompleto === true,
    'C1b con IGTF cubierto en divisa → pago completo');

  // ── Caso 2: pago 100% en Bs → IGTF = 0 (base imponible en divisas = 0) ──
  const c2 = await post({ totalUSD: 100, tasaBCV: 820.1018, efectivoVES: 82100 });
  assert(numEq(c2.fiscal?.igtfUSD, 0), `C2 pago íntegro en Bs → IGTF = ${c2.fiscal?.igtfUSD}`);
  assert(c2.resultado?.vueltoUSD !== undefined, 'C2 respuesta con vuelto calculado');

  // ── Caso 3: mixto con tasa irregular; base = total − Bs equivalentes ──
  // Base esperada computada con doubles a 6 dec (suficiente para validar):
  const bsEq3 = 19233.735588 / 820.101823;
  const base3 = Math.min(10.111111, Math.max(33.335 - bsEq3, 0));
  const igtf3 = base3 * 0.03;
  const c3 = await post({
    totalUSD: 33.335, tasaBCV: 820.101823, efectivoUSD: 10.111111, pagoMovil: 19233.735588
  });
  assert(numEq(c3.fiscal?.baseIGTFUSD, base3, 1e-5),
    `C3 base = total−Bs (${c3.fiscal?.baseIGTFUSD} vs ${base3.toFixed(6)})`);
  assert(numEq(c3.fiscal?.igtfUSD, igtf3, 1e-5),
    `C3 IGTF 3% de la base = ${c3.fiscal?.igtfUSD} (6 dec)`);
  assert(c3.precision?.memoria === 6 && c3.precision?.ui === 2, 'C3 contrato de precisión 6/2');
  assert(typeof c3.ui?.igtfUSD === 'number', `C3 IGTF UI a 2 dec = ${c3.ui?.igtfUSD}`);

  // ── Caso 4: parámetros inválidos controlados ──
  const c4raw = await fetch(`${BASE}/pagos/procesar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ totalUSD: 0, tasaBCV: 0 })
  });
  assert(c4raw.status === 400, `C4 totalUSD/tasaBCV ≤ 0 → HTTP ${c4raw.status}`);

  // ── Caso 5: falta de efectivo detectada ──
  const c5 = await post({ totalUSD: 100, tasaBCV: 820.1018, efectivoUSD: 40 });
  assert(c5.resultado?.pagoCompleto === false, 'C5 pago insuficiente marcado');
  assert(parseFloat(c5.resultado?.faltaUSD) > 60, `C5 falta = ${c5.resultado?.faltaUSD} USD`);

  // ── Caso 6: exceso de divisa no se grava ($105 divisa para total $100) ──
  const c6 = await post({ totalUSD: 100, tasaBCV: 820.1018, efectivoUSD: 105 });
  assert(numEq(c6.fiscal?.baseIGTFUSD, 100), `C6 base = total (${c6.fiscal?.baseIGTFUSD}), no el efectivo`);
  assert(numEq(c6.fiscal?.igtfUSD, 3), `C6 IGTF = 3.00 (no 3.15) = ${c6.fiscal?.igtfUSD}`);
  assert(numEq(c6.resultado?.vueltoUSD, 2, 0.001), `C6 vuelto = ${c6.resultado?.vueltoUSD} USD`);

  // ── Caso 7: autenticación requerida ──
  const c7 = await fetch(`${BASE}/pagos/procesar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ totalUSD: 10, tasaBCV: 1 })
  });
  assert(c7.status === 401 || c7.status === 403, `C7 sin token → HTTP ${c7.status}`);

  console.log('\nMOTOR DE PAGOS DECIMAL: TODOS LOS CASOS LÍMITE EN VERDE');
})().catch((e) => {
  console.log(`❌ ${e.message}`);
  process.exit(1);
});
