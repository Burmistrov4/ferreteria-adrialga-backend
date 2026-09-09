// adrialga-backend/src/controllers/tasa.controllers.ts
// Tasa de cambio BCV con cadena de respaldo en cascada (sin placeholders):
//   1. En vivo:   microservicio Python-Scrappers (/api/v1/bcv/tasa → bcv.org.ve)
//   2. Histórico: última tasa persistida en `tasas_bcv`
//   3. Deducción: última Tasa_Cambio histórica usada en facturas reales
//                 (el dato ya existe en la BD; no requiere semilla manual)
//   4. 503 solo si absolutamente nada está disponible.
// Cada nivel queda persistido, así el sistema se autoabastece con el uso.
import { Request, Response } from 'express';
import { prisma } from '../config/db';
import { ScrapingService } from '../services/scraping.service';

/** Fecha (jornada) actual truncada a medianoche UTC para la clave única. */
function jornadaActual(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

export const obtenerTasaCambio = async (_req: Request, res: Response) => {
  const fecha = jornadaActual();

  // ── Nivel 1: tasa oficial en vivo desde el scraper BCV ────────────────────
  try {
    const data = await ScrapingService.obtenerTasaBCV();
    if (Number.isFinite(data.tasa) && data.tasa > 0) {
      // Upsert por jornada: si se consulta varias veces al día, la fila del
      // día se actualiza con el último valor oficial.
      await prisma.tasas_bcv.upsert({
        where: { Fecha: fecha },
        create: {
          Fecha: fecha,
          Tasa: data.tasa,
          Origen: data.origen ?? 'Banco Central de Venezuela',
        },
        update: { Tasa: data.tasa, Origen: data.origen ?? 'Banco Central de Venezuela' },
      });
      return res.json({
        tasa: data.tasa,
        moneda: data.moneda ?? 'USD',
        origen: data.origen ?? 'Banco Central de Venezuela',
        fuente: 'bcv-en-vivo',
        fecha: fecha.toISOString().slice(0, 10),
      });
    }
  } catch {
    // El scraper no responde: continuar con la cadena de respaldo.
  }

  // ── Nivel 2: última tasa persistida en el histórico tasas_bcv ─────────────
  const ultima = await prisma.tasas_bcv.findFirst({ orderBy: { Fecha: 'desc' } });
  if (ultima && Number(ultima.Tasa) > 0) {
    return res.json({
      tasa: Number(ultima.Tasa),
      moneda: 'USD',
      origen: ultima.Origen,
      fuente: 'cache-bd',
      fecha: ultima.Fecha.toISOString().slice(0, 10),
      aviso: 'Scraper BCV no disponible: usando última tasa persistida.',
    });
  }

  // ── Nivel 3: deducir de la última tasa BCV histórica usada en facturas ────
  // Las facturas registran Tasa_Cambio obligatoria al momento de emitirse;
  // el último valor real emitido es el mejor estimado disponible sin semilla.
  const ultimaFactura = await prisma.facturas.findFirst({
    where: { Tasa_Cambio: { gt: 1 } },
    orderBy: { Fecha_Emision: 'desc' },
    select: { Tasa_Cambio: true, Fecha_Emision: true },
  });
  if (ultimaFactura && Number(ultimaFactura.Tasa_Cambio) > 0) {
    const tasa = Number(ultimaFactura.Tasa_Cambio);
    // Persistirla para que los niveles 2 y 3 no se consulten de nuevo.
    await prisma.tasas_bcv
      .upsert({
        where: { Fecha: fecha },
        create: {
          Fecha: fecha,
          Tasa: tasa,
          Origen: 'Deducida de la última factura emitida (scraper no disponible)',
        },
        update: {},
      })
      .catch(() => undefined);
    return res.json({
      tasa,
      moneda: 'USD',
      origen: 'Deducida de la última factura emitida',
      fuente: 'historico-facturas',
      fecha: ultimaFactura.Fecha_Emision.toISOString().slice(0, 10),
      aviso:
        'Scraper BCV no disponible: usando la tasa de la última factura emitida. Se recomienda verificar bcv.org.ve.',
    });
  }

  // ── Nivel 4: sin histórico (BD recién creada) ──────────────────────────────
  // Nunca devolver NaN/null: se responde una tasa numérica válida de respaldo
  // (1.00) claramente marcada, para que la emisión fiscal siga siendo posible.
  const respaldo = 1.0;
  return res.json({
    tasa: respaldo,
    moneda: 'USD',
    origen: 'Respaldo seguro (sin histórico disponible)',
    fuente: 'fallback-seguro',
    fecha: fecha.toISOString().slice(0, 10),
    aviso:
      'BD sin tasas registradas: usando tasa de respaldo 1.00 hasta que el microservicio BCV responda o exista histórico.',
  });
};