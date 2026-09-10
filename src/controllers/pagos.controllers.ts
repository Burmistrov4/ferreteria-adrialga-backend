// adrialga-backend/src/controllers/pagos.controllers.ts
// ─────────────────────────────────────────────────────────────────────────────
// Motor de pagos mixtos (USD + Bs) con precisión DECIMAL exacta vía decimal.js.
//
// Regla por mandato: el IGTF (3%) se aplica ESTRICTA y ÚNICAMENTE sobre la
// porción pagada en moneda extranjera. Si una factura de $100 se paga $50 en
// divisa y el equivalente a $50 en Bs, la base del IGTF es $50 (no $100).
//
// Precisión: 6 decimales en memoria (Decimal.set precision 20) y la respuesta
// JSON expone BOTH: internos a 6 decimales (r6) y valores de UI a 2 decimales
// (r2), para que Flutter muestre montos legibles sin perder exactitud.
// ─────────────────────────────────────────────────────────────────────────────
import { Request, Response } from 'express';
import { Decimal } from 'decimal.js';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

const IGTF_ALICUOTA = new Decimal('0.03');

/** Parseo seguro: tolera comas decimales, signos y basura no numérica. */
function dec(valor: unknown): Decimal {
  const s = String(valor ?? '').trim().replace(',', '.').replace(/\s/g, '');
  const d = new Decimal(s === '' ? '0' : s);
  return d.isFinite() ? d : new Decimal(0);
}

interface PagoEntrada {
  medio: string;
  monto: Decimal;
  esDivisa: boolean;
}

/**
 * POST /api/pagos/procesar
 * Body (cualquier valor numérico): { totalUSD, tasaBCV, efectivoUSD, efectivoVES,
 * pagoMovil, puntoVenta }.
 * Devuelve el desglose fiscal exacto (IGTF aislado a divisas) + resultado de
 * vuelto/falta, con precisión de 6 decimales e ítems de UI a 2 decimales.
 */
export const procesarPagoMixto = async (req: Request, res: Response) => {
  const totalUSD = dec(req.body.totalUSD);
  const tasaBCV = dec(req.body.tasaBCV);

  if (totalUSD.lte(0) || tasaBCV.lte(0)) {
    return res.status(400).json({
      error: 'totalUSD y tasaBCV deben ser mayores a 0',
      detalle: 'Parámetros: totalUSD, tasaBCV, efectivoUSD, efectivoVES, pagoMovil, puntoVenta'
    });
  }

  const medios: PagoEntrada[] = [
    { medio: 'Efectivo USD', monto: dec(req.body.efectivoUSD), esDivisa: true },
    // Extensiones futuras de divisa (Zelle/Transferencia USD) se agregarían aquí
    // con esDivisa: true y el IGTF se aislaría automáticamente.
    { medio: 'Efectivo VES', monto: dec(req.body.efectivoVES), esDivisa: false },
    { medio: 'Pago Móvil', monto: dec(req.body.pagoMovil), esDivisa: false },
    { medio: 'Punto de Venta', monto: dec(req.body.puntoVenta), esDivisa: false }
  ].filter((p) => p.monto.gt(0));

  // ── IGTF 3%: base imponible = porción del TOTAL cubierta en divisa ────────
  // El efectivo físico en divisa que EXCEDE el total genera vuelto (no gravado):
  // si el cliente entrega $105 para cubrir $101.50, la base IGTF es la porción
  // del total cubierta con divisa ($50 en el ejemplo del mandato), nunca el
  // efectivo bruto entregado. Orden de imputación: la divisa se aplica primero
  // al total; los Bs cubren el restante; cualquier sobrante es vuelto.
  const totalDivisaRecibidoUSD = medios
    .filter((m) => m.esDivisa)
    .reduce((acc, m) => acc.plus(m.monto), new Decimal(0));
  const totalBs = medios
    .filter((m) => !m.esDivisa)
    .reduce((acc, m) => acc.plus(m.monto), new Decimal(0));
  const totalBsEnUSD = totalBs.div(tasaBCV);

  // Divisa aplicada al total (tope = totalUSD; el exceso es vuelto en divisa).
  // Base IGTF = porción del TOTAL cubierta en divisa:
  //   · Los Bs se imputan primero a la porción del total que cubren.
  //   · La divisa gravada es la que cubre el restante del total (tope: lo
  //     que de divisa se entregó). El efectivo físico en divisa que excede
  //     esa porción (vuelto o pago del propio IGTF) NO se grava.
  // Ejemplos: $50 divisa + $50-eq Bs de un total $100 → base $50 (mandato).
  //           $105 divisa sola de un total $100 → base $100, vuelto $2.
  const restanteTotalSinBs = Decimal.max(totalUSD.minus(totalBsEnUSD), new Decimal(0));
  const baseIGTFUSD = Decimal.min(totalDivisaRecibidoUSD, restanteTotalSinBs);
  const igtfUSD = baseIGTFUSD.mul(IGTF_ALICUOTA).toDecimalPlaces(6);
  const cargoTotalUSD = totalUSD.plus(igtfUSD);

  // ── Total recibido en USD (los pagos en Bs se convierten a tasa BCV) ──────
  const totalRecibidoUSD = totalDivisaRecibidoUSD.plus(totalBsEnUSD);

  const diferenciaUSD = totalRecibidoUSD.minus(cargoTotalUSD);
  const faltaUSD = diferenciaUSD.lt(0) ? diferenciaUSD.abs() : new Decimal(0);
  const vueltoUSD = diferenciaUSD.gt(0) ? diferenciaUSD : new Decimal(0);

  // Redondeo exacto (HALF-UP) a 6 (interno) y 2 (UI) decimales.
  const r6 = (d: Decimal) => d.toDecimalPlaces(6).toString();
  const r2 = (d: Decimal) => d.toDecimalPlaces(2).toNumber();

  return res.json({
    motor: 'decimal.js',
    precision: { memoria: 6, ui: 2 },
    ingresos: {
      efectivoUSD: r6(medios.find((m) => m.medio === 'Efectivo USD')?.monto ?? new Decimal(0)),
      efectivoVES: r6(medios.find((m) => m.medio === 'Efectivo VES')?.monto ?? new Decimal(0)),
      pagoMovil: r6(medios.find((m) => m.medio === 'Pago Móvil')?.monto ?? new Decimal(0)),
      puntoVenta: r6(medios.find((m) => m.medio === 'Punto de Venta')?.monto ?? new Decimal(0)),
      totalBs: r6(totalBs),
      totalDivisaUSD: r6(totalDivisaRecibidoUSD)
    },
    fiscal: {
      baseIGTFUSD: r6(baseIGTFUSD), // porción del total cubierta en divisa
      alicuotaIGTF: '3.000000',
      igtfUSD: r6(igtfUSD),
      igtfVES: r6(igtfUSD.mul(tasaBCV)),
      cargoTotalUSD: r6(cargoTotalUSD),
      totalUSDOriginal: r6(totalUSD)
    },
    resultado: {
      totalRecibidoUSD: r6(totalRecibidoUSD),
      diferenciaUSD: r6(diferenciaUSD),
      faltaUSD: r6(faltaUSD),
      faltaVES: r6(faltaUSD.mul(tasaBCV)),
      vueltoUSD: r6(vueltoUSD),
      vueltoVES: r6(vueltoUSD.mul(tasaBCV)),
      pagoCompleto: faltaUSD.lte(new Decimal('0.01'))
    },
    ui: {
      totalCargoUSD: r2(cargoTotalUSD),
      igtfUSD: r2(igtfUSD),
      faltaUSD: r2(faltaUSD),
      vueltoUSD: r2(vueltoUSD)
    }
  });
};