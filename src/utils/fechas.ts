/**
 * Utilidades de rango de fechas con bordes inclusivos exactos.
 *
 * `desde` siempre es 00:00:00.000 del primer día del periodo y
 * `hasta` es 23:59:59.999 del último día (por defecto, el día actual),
 * de modo que ninguna factura quede fuera por precisión temporal.
 */

export type Periodo = 'hoy' | 'semana' | 'mes' | 'anio';

export interface RangoFecha {
  desde: Date;
  hasta: Date;
  /** Formato de agrupación de MySQL (DATE_FORMAT) para series temporales. */
  formatoSQL: string;
}

function inicioDelDia(fecha: Date = new Date()): Date {
  const d = new Date(fecha);
  d.setHours(0, 0, 0, 0);
  return d;
}

function finDelDia(fecha: Date = new Date()): Date {
  const d = new Date(fecha);
  d.setHours(23, 59, 59, 999);
  return d;
}

/**
 * Construye un rango inclusivo exacto a partir de dos cadenas de fecha
 * (ISO 'YYYY-MM-DD' o cualquier formato que `Date.parse` acepte).
 *
 * La demarcación de bordes (00:00:00.000 a 23:59:59.999) se hace aquí, en el
 * backend, para que la zona horaria del servidor sea la única fuente de
 * verdad y ningún registro quede fuera por precisión temporal.
 *
 * Devuelve `null` si alguno de los valores no es una fecha válida.
 */
export function rangoPersonalizado(
  desdeStr: string,
  hastaStr: string
): { desde: Date; hasta: Date } | null {
  const dIni = new Date(desdeStr);
  const dFin = new Date(hastaStr);
  if (isNaN(dIni.getTime()) || isNaN(dFin.getTime())) return null;
  // Si el usuario invierte el rango, se intercambian los extremos.
  const [a, b] = dIni <= dFin ? [dIni, dFin] : [dFin, dIni];
  return { desde: inicioDelDia(a), hasta: finDelDia(b) };
}

/**
 * Normaliza el parámetro `periodo` de la query string a un valor seguro.
 * Cualquier valor desconocido cae en 'hoy'.
 */
export function normalizarPeriodo(valor: unknown): Periodo {
  const p = String(valor ?? 'hoy').toLowerCase();
  return (['hoy', 'semana', 'mes', 'anio'] as const).includes(p as Periodo)
    ? (p as Periodo)
    : 'hoy';
}

/**
 * Devuelve el rango [desde, hasta] del periodo solicitado junto al formato
 * de agrupación SQL apropiado para construir series temporales.
 */
export function calcularRango(periodo: Periodo): RangoFecha {
  const ahora = new Date();
  const hasta = finDelDia(ahora); // siempre hasta el final del día actual

  switch (periodo) {
    case 'hoy':
      // Serie por HORA del día actual
      return { desde: inicioDelDia(ahora), hasta, formatoSQL: '%H:00' };
    case 'semana': {
      const desde = inicioDelDia(ahora);
      desde.setDate(desde.getDate() - 6); // últimos 7 días, serie por DÍA
      return { desde, hasta, formatoSQL: '%Y-%m-%d' };
    }
    case 'mes': {
      const desde = inicioDelDia(ahora);
      desde.setDate(1); // mes en curso, serie por DÍA
      return { desde, hasta, formatoSQL: '%Y-%m-%d' };
    }
    case 'anio': {
      const desde = new Date(ahora.getFullYear(), 0, 1); // año en curso
      return { desde, hasta, formatoSQL: '%Y-%m' };
    }
  }
}
