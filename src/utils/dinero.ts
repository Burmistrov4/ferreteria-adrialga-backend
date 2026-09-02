// adrialga-backend/src/utils/dinero.ts
// ─────────────────────────────────────────────────────────────────────────────
// Motor matemático monetario con precisión fija de 4 decimales.
//
// Estrategia: aritmética entera BigInt con escala fija ESCALA = 10_000 (1e4).
// Ningún monto atraviesa el sistema como float: la cadena es siempre
//   API (string de Prisma / number de la UI) → BigInt ×1e4 → DECIMAL(12,4).
//
// Redondeo HALF-UP (comercial) al 4º decimal en cada conversión de entrada,
// de modo que las 4 operaciones básicas son EXACTAS sobre valores ya
// normalizados (en la práctica: exactas para todos los montos monetarios).
// ─────────────────────────────────────────────────────────────────────────────

const ESCALA = 10_000n; // 4 decimales
const MITAD = 5_000n; // 0.0005 escalado (para HALF-UP)

/** Convierte un valor de entrada (string de Prisma, number, string de UI)
 *  a BigInt escalado ×1e4 con redondeo HALF-UP al 4º decimal. */
export function toD4(valor: unknown): bigint {
  if (valor === null || valor === undefined) return 0n;

  let s = String(valor).trim();
  if (s === '') return 0n;

  const negativo = s.startsWith('-');
  if (negativo || s.startsWith('+')) s = s.slice(1);

  // Normalizar coma decimal → punto y descartar separadores de miles/símbolos
  s = s.replace(',', '.').replace(/[^0-9.]/g, '');

  const [entera = '0', decimal = ''] = s.split('.');
  const dec = (decimal + '0000').slice(0, 4); // primeros 4 decimales
  const resto = decimal.length > 4 ? decimal.slice(4) : ''; // para HALF-UP

  let escalado =
    BigInt(entera || '0') * ESCALA + BigInt(dec.padEnd(4, '0') || '0');

  // HALF-UP sobre el resto truncado (p. ej. "0.00005" → sube a 0.0001)
  if (resto && BigInt(resto[0]) >= 5n) escalado += 1n;

  return negativo ? -escalado : escalado;
}

/** Suma exacta. */
export const addD4 = (a: bigint, b: bigint): bigint => a + b;

/** Resta exacta. */
export const subD4 = (a: bigint, b: bigint): bigint => a - b;

/** Multiplicación exacta: (a ×1e4)·(b ×1e4)/1e4, redondeo HALF-UP. */
export function mulD4(a: bigint, b: bigint): bigint {
  const producto = a * b; // escala 1e8
  const cociente = producto / ESCALA;
  const residuo = producto % ESCALA;
  const ajuste = residuo >= MITAD || residuo <= -MITAD ? 1n : 0n;
  return cociente + (producto >= 0n ? ajuste : -ajuste);
}

/** División con precisión 4 decimales, redondeo HALF-UP. */
export function divD4(a: bigint, b: bigint): bigint {
  if (b === 0n) return 0n;
  const numerador = a * ESCALA; // escala 1e8
  const cociente = numerador / b;
  const residuoAbs =
    (numerador % b) < 0n ? -(numerador % b) : numerador % b;
  const bAbs = b < 0n ? -b : b;
  const sube = residuoAbs * 2n >= bAbs;
  if (!sube) return cociente;
  return cociente + (numerador >= 0n ? 1n : -1n);
}

/** BigInt escalado → string con exactamente 4 decimales (formato Prisma). */
export function aDecimal(escalado: bigint): string {
  const negativo = escalado < 0n;
  const abs = negativo ? -escalado : escalado;
  const entera = abs / ESCALA;
  const decimal = (abs % ESCALA).toString().padStart(4, '0');
  return `${negativo ? '-' : ''}${entera}.${decimal}`;
}

/** Constantes fiscales (escaladas ×1e4). 16% → 160_000n; 3% → 30_000n. */
export const IVA_ALIQUOTA = 160_000n; // 16.0000%
export const IGTF_ALIQUOTA = 30_000n; // 3.0000%
export const CIEN = 1_000_000n; // 100.0000 escalado (divisor de porcentajes)
