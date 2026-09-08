// src/utils/arqueo.ts
// Evaluación de arqueo de caja: lógica pura (testeable sin BD).
// Regla de negocio: el conteo del cajero debe coincidir con el saldo esperado
// dentro de una tolerancia (±1 USD por redondeos o monedas menores); una
// diferencia mayor se rechaza para forzar la conciliación.

export interface ResultadoArqueo {
  /** true si el conteo cuadra dentro de la tolerancia. */
  cuadra: boolean;
  /** esperado − contado. >0 → faltante; <0 → sobrante; ≈0 → OK. */
  diferencia: number;
}

/**
 * Evalúa el arqueo comparando el saldo esperado del turno contra el conteo
 * físico del cajero. Si `montoContado` es null (cajero no cuenta), se
 * considera válido por defecto (cierre sin conciliación física).
 */
export function evaluarArqueo(
  saldoEsperado: number,
  montoContado: number | null,
  tolerancia = 1.0
): ResultadoArqueo {
  if (montoContado === null || !Number.isFinite(montoContado)) {
    return { cuadra: true, diferencia: 0 };
  }
  const diferencia = Number((saldoEsperado - montoContado).toFixed(4));
  return { cuadra: Math.abs(diferencia) <= tolerancia, diferencia };
}