// scripts/test_arqueo.ts
// Test unitario de la lógica de arqueo (sin BD). Ejecutar con:
//   npx ts-node scripts/test_arqueo.ts
import assert from 'assert';
import { evaluarArqueo } from '../src/utils/arqueo';

let pruebas = 0;
function caso(nombre: string, fn: () => void) {
  fn();
  pruebas++;
  console.log(`  ✓ ${nombre}`);
}

console.log('— evaluarArqueo —');

caso('Conteo exacto cuadra', () => {
  const r = evaluarArqueo(125.5, 125.5);
  assert.strictEqual(r.cuadra, true);
  assert.strictEqual(r.diferencia, 0);
});

caso('Diferencia de redondeo dentro de la tolerancia (±1 USD) cuadra', () => {
  const r1 = evaluarArqueo(100.0, 100.75);
  assert.strictEqual(r1.cuadra, true);
  const r2 = evaluarArqueo(100.0, 99.3);
  assert.strictEqual(r2.cuadra, true);
});

caso('Faltante mayor a la tolerancia NO cuadra (422 esperado)', () => {
  const r = evaluarArqueo(100.0, 98.5);
  assert.strictEqual(r.cuadra, false);
  assert.strictEqual(r.diferencia, 1.5);
  assert.ok(r.diferencia > 0, 'faltante = diferencia positiva');
});

caso('Sobrante mayor a la tolerancia NO cuadra', () => {
  const r = evaluarArqueo(100.0, 102.0);
  assert.strictEqual(r.cuadra, false);
  assert.strictEqual(r.diferencia, -2);
  assert.ok(r.diferencia < 0, 'sobrante = diferencia negativa');
});

caso('Sin conteo (null) se considera válido (cierre sin conciliación física)', () => {
  const r = evaluarArqueo(500.0, null);
  assert.strictEqual(r.cuadra, true);
  assert.strictEqual(r.diferencia, 0);
});

caso('Conteo NaN se trata como ausente', () => {
  const r = evaluarArqueo(500.0, NaN);
  assert.strictEqual(r.cuadra, true);
});

caso('Precisión a 4 decimales (floats no contaminan)', () => {
  const r = evaluarArqueo(0.3, 0.1 + 0.2);
  assert.strictEqual(r.diferencia, -0);
  assert.strictEqual(r.cuadra, true);
});

caso('Tolerancia configurable', () => {
  const r = evaluarArqueo(100.0, 102.0, 2.0);
  assert.strictEqual(r.cuadra, true);
});

console.log(`\n${pruebas}/${pruebas} pruebas de arqueo OK`);