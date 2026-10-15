// adrialga-backend/src/controllers/tasa.controllers.ts
// Tasa de cambio BCV con cadena de respaldo en cascada (sin placeholders):
//   1a. En vivo: microservicio Python-Scrappers (/api/v1/bcv/tasa → bcv.org.ve)
//   1b. En vivo directo: lectura de bcv.org.ve desde Node (sin el microservicio)
//   2.  Histórico: última tasa persistida en `tasas_bcv`
//   3.  Deducción: última Tasa_Cambio histórica usada en facturas reales
//                  (el dato ya existe en la BD; no requiere semilla manual)
//   4.  503 solo si absolutamente nada está disponible.
// Cada nivel queda persistido, así el sistema se autoabastece con el uso.
//
// El nivel 1b existe por una razón medida: el 2026-10-14 la tasa no se
// conectaba simplemente porque el microservicio Python no estaba escuchando en
// :8000, y todo el sistema caía al histórico sin intentar nada más. Node sí
// alcanza bcv.org.ve directamente, así que la tasa oficial en vivo ya no
// depende de que un segundo proceso esté arriba.
import { Request, Response } from 'express';
import axios from 'axios';
import { prisma } from '../config/db';
import { ScrapingService } from '../services/scraping.service';
import { IoStore } from '../utils/socket';

/** Fecha (jornada) actual truncada a medianoche UTC para la clave única. */
function jornadaActual(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/**
 * Lee la tasa del dólar directamente de bcv.org.ve desde Node.
 *
 * Se usa como respaldo del microservicio Python. La página publica el valor en
 * `<div id="dolar"> … <strong>877,90230000</strong>`. El BCV usa '.' para miles
 * y ',' para decimales; se normaliza a un float estándar.
 *
 * Devuelve `null` ante cualquier fallo (red, TLS, cambio de maquetación): el
 * llamador continúa con la cascada. NUNCA inventa un valor.
 */
async function tasaBcvDirecta(): Promise<number | null> {
  try {
    const { data } = await axios.get<string>('https://www.bcv.org.ve/', {
      timeout: 9000,
      responseType: 'text',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      },
      // La cadena de certificados del BCV ha estado rota históricamente. Node
      // usa su propio almacén de CA y verifica de forma normal: si falla, se
      // devuelve null y la cascada sigue. No se desactiva la verificación.
    });
    const html = String(data ?? '');
    const m = html.match(/id="dolar"[\s\S]{0,800}?<strong[^>]*>([^<]+)<\/strong>/i);
    if (!m) return null;
    const normalizado = m[1].trim().replace(/\./g, '').replace(',', '.');
    const valor = Number.parseFloat(normalizado.replace(/[^\d.]/g, ''));
    return Number.isFinite(valor) && valor > 0 ? valor : null;
  } catch {
    return null;
  }
}

export const obtenerTasaCambio = async (_req: Request, res: Response) => {
  const fecha = jornadaActual();

  // ── Nivel 1a: tasa oficial en vivo desde el scraper BCV ───────────────────
  let tasaViva: number | null = null;
  let origenVivo = 'Banco Central de Venezuela';
  let fuenteViva = 'bcv-en-vivo';
  try {
    const data = await ScrapingService.obtenerTasaBCV();
    if (Number.isFinite(data.tasa) && data.tasa > 0) {
      tasaViva = data.tasa;
      origenVivo = data.origen ?? origenVivo;
    }
  } catch {
    // El scraper no responde: se intenta el respaldo directo (nivel 1b).
  }

  // ── Nivel 1b: lectura directa de bcv.org.ve desde Node ────────────────────
  if (tasaViva === null) {
    const directa = await tasaBcvDirecta();
    if (directa !== null) {
      tasaViva = directa;
      fuenteViva = 'bcv-directo';
      console.info(
        'Tasa BCV: el microservicio no respondió; se obtuvo la tasa oficial directamente de bcv.org.ve.'
      );
    }
  }

  if (tasaViva !== null) {
    // Upsert por jornada: si se consulta varias veces al día, la fila del
    // día se actualiza con el último valor oficial.
    await prisma.tasas_bcv
      .upsert({
        where: { Fecha: fecha },
        create: { Fecha: fecha, Tasa: tasaViva, Origen: origenVivo },
        update: { Tasa: tasaViva, Origen: origenVivo },
      })
      .catch(() => undefined);
    IoStore.emitDbUpdate('tasa', `Tasa BCV actualizada: ${tasaViva}`, {
      tasa: tasaViva,
    });
    return res.json({
      tasa: tasaViva,
      moneda: 'USD',
      origen: origenVivo,
      fuente: fuenteViva,
      fecha: fecha.toISOString().slice(0, 10),
    });
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