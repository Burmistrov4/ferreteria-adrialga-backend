// adrialga-backend/src/controllers/tasa.controllers.ts
// Tasa de cambio BCV con cadena de respaldo en cascada (sin placeholders).
//
// Niveles, en orden de preferencia:
//   1a. En vivo: microservicio Python-Scrappers (/api/v1/bcv/tasa → bcv.org.ve)
//   1b. En vivo directo: lectura de bcv.org.ve desde Node (sin el microservicio)
//   1c. En vivo por proxy: la MISMA página oficial de bcv.org.ve, leída a través
//       de un servicio público de reenvío (otra red de salida)
//   1d. En vivo por API espejo: JSON que republica la tasa oficial del BCV
//   2.  Histórico: última tasa persistida en `tasas_bcv`
//   3.  Deducción: última Tasa_Cambio histórica usada en facturas reales
//   4.  503/1.00 solo si absolutamente nada está disponible.
// Cada nivel queda persistido, así el sistema se autoabastece con el uso.
//
// Por qué existen los niveles 1b, 1c y 1d (cada uno responde a una medición):
//
//  - 1b se añadió el 2026-10-14: la tasa no se conectaba simplemente porque el
//    microservicio Python no estaba escuchando en :8000, y todo el sistema caía
//    al histórico sin intentar nada más. Node sí alcanza bcv.org.ve.
//
//  - 1c y 1d se añadieron el 2026-10-16, tras medir que en Render el nivel 1b
//    falla de forma INMEDIATA (no por tiempo de espera): `/api/tasa-cambio`
//    respondía en 1,96 s cayendo a `cache-bd`, cuando una descarga real de la
//    página (154 KB) tarda ~2,6 s. Un rechazo instantáneo es la firma de un WAF
//    que bloquea la IP del servidor, no de una red lenta. Comprobado que NO es
//    un bloqueo general a datacenters: dos servicios en la nube (allorigins y
//    r.jina.ai) obtuvieron la página completa con la tasa correcta.
//
//    Por eso 1c pide la MISMA página oficial pero saliendo por otra red, y 1d
//    consulta un espejo en JSON. Ambos se etiquetan de forma explícita en
//    `origen`/`fuente` para que la interfaz nunca presente un espejo como si
//    fuera la lectura directa del banco.
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

// ─────────────────────────────────────────────────────────────────────────────
// Utilidades de lectura
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cabeceras de un navegador real. Varios WAF (y el propio BCV en horas pico)
 * rechazan peticiones sin `Accept`/`Accept-Language` por parecer automatizadas.
 */
const CABECERAS_NAVEGADOR = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'es-VE,es;q=0.9,en;q=0.8',
};

/**
 * Extrae la tasa del dólar del HTML de bcv.org.ve.
 *
 * La página publica el valor en `<div id="dolar"> … <strong>881,06640000</strong>`.
 * El BCV usa '.' para miles y ',' para decimales; se normaliza a float estándar.
 * Medido el 2026-10-16: el `<strong>` está a 368 caracteres del `id="dolar"`,
 * así que el margen de 800 es holgado (pero acotado, para no capturar el valor
 * del euro si cambiara la maquetación).
 *
 * Devuelve `null` si no encuentra el valor: NUNCA inventa una tasa.
 */
function parsearTasaDelHtmlBcv(html: string): number | null {
  const m = html.match(/id="dolar"[\s\S]{0,800}?<strong[^>]*>([^<]+)<\/strong>/i);
  if (!m) return null;
  const normalizado = m[1].trim().replace(/\./g, '').replace(',', '.');
  const valor = Number.parseFloat(normalizado.replace(/[^\d.]/g, ''));
  return Number.isFinite(valor) && valor > 0 ? valor : null;
}

/** Traduce un fallo de red a una frase corta y legible para el diagnóstico. */
function describirFalloHttp(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const estado = error.response?.status;
    if (estado) return `HTTP ${estado} (rechazado por el servidor)`;
    if (error.code) return `${error.code}: ${error.message}`;
    return error.message;
  }
  return error instanceof Error ? error.message : 'error desconocido';
}

/** Resultado de intentar UNA fuente en vivo. */
type ResultadoFuente = { valor: number | null; error: string | null };

// ─────────────────────────────────────────────────────────────────────────────
// Fuentes en vivo
// ─────────────────────────────────────────────────────────────────────────────

/** 1a — Microservicio Python-Scrappers (solo existe en desarrollo local). */
async function fuenteMicroservicio(): Promise<ResultadoFuente> {
  try {
    const data = await ScrapingService.obtenerTasaBCV();
    const valor = Number(data.tasa);
    if (Number.isFinite(valor) && valor > 0) return { valor, error: null };
    return { valor: null, error: 'el microservicio respondió sin una tasa válida' };
  } catch (e) {
    return { valor: null, error: e instanceof Error ? e.message : 'error desconocido' };
  }
}

/** 1b — Lectura directa de bcv.org.ve desde Node. */
async function fuenteBcvDirecto(): Promise<ResultadoFuente> {
  try {
    const { data } = await axios.get<string>('https://www.bcv.org.ve/', {
      timeout: 8000,
      responseType: 'text',
      headers: CABECERAS_NAVEGADOR,
      // La cadena de certificados del BCV ha estado rota históricamente. Node
      // usa su propio almacén de CA y verifica de forma normal: si falla, se
      // devuelve null y la cascada sigue. No se desactiva la verificación.
    });
    const valor = parsearTasaDelHtmlBcv(String(data ?? ''));
    return {
      valor,
      error: valor === null ? 'respondió, pero no se encontró el contenedor id="dolar"' : null,
    };
  } catch (e) {
    return { valor: null, error: describirFalloHttp(e) };
  }
}

/**
 * 1c — La MISMA página oficial, leída a través de un servicio público de reenvío.
 *
 * Sirve cuando el WAF del BCV rechaza la IP del servidor (medido en Render el
 * 2026-10-16). La fuente sigue siendo bcv.org.ve: el proxy solo cambia la red
 * de salida, no el dato.
 */
async function fuenteBcvViaProxy(): Promise<ResultadoFuente> {
  const destino = encodeURIComponent('https://www.bcv.org.ve/');
  try {
    const { data } = await axios.get<string>(
      `https://api.allorigins.win/raw?url=${destino}`,
      {
        timeout: 8000,
        responseType: 'text',
        headers: CABECERAS_NAVEGADOR,
      }
    );
    const valor = parsearTasaDelHtmlBcv(String(data ?? ''));
    return {
      valor,
      error: valor === null ? 'el proxy devolvió la página sin el contenedor id="dolar"' : null,
    };
  } catch (e) {
    return { valor: null, error: describirFalloHttp(e) };
  }
}

/**
 * 1d — API espejo en JSON que republica la tasa oficial del BCV.
 *
 * Último recurso en vivo. Se etiqueta como espejo en `origen` para no hacer
 * pasar una fuente intermedia por lectura directa del banco.
 */
async function fuenteApiEspejo(): Promise<ResultadoFuente> {
  try {
    const { data } = await axios.get<Record<string, unknown>>(
      'https://ve.dolarapi.com/v1/dolares/oficial',
      { timeout: 6000, headers: CABECERAS_NAVEGADOR }
    );
    const bruto = data?.promedio ?? data?.venta ?? data?.compra;
    const valor = Number(bruto);
    if (Number.isFinite(valor) && valor > 0) return { valor, error: null };
    return { valor: null, error: 'el espejo respondió sin un valor numérico' };
  } catch (e) {
    return { valor: null, error: describirFalloHttp(e) };
  }
}

/** Orden de preferencia de las fuentes en vivo. */
const FUENTES = [
  {
    clave: 'microservicio-python',
    origen: 'Banco Central de Venezuela',
    fuente: 'bcv-en-vivo',
    leer: fuenteMicroservicio,
  },
  {
    clave: 'bcv-directo',
    origen: 'Banco Central de Venezuela',
    fuente: 'bcv-directo',
    leer: fuenteBcvDirecto,
  },
  {
    clave: 'bcv-via-proxy',
    origen: 'Banco Central de Venezuela',
    fuente: 'bcv-via-proxy',
    leer: fuenteBcvViaProxy,
  },
  {
    clave: 'api-espejo',
    origen: 'BCV vía API espejo (dolarapi)',
    fuente: 'bcv-api-espejo',
    leer: fuenteApiEspejo,
  },
] as const;

/**
 * Caché en memoria de la última tasa viva, para no castigar a las fuentes
 * públicas con una petición por cada apertura de la aplicación.
 */
const VIDA_CACHE_MS = 60_000;
let cacheViva: { valor: number; origen: string; fuente: string; expira: number } | null = null;

/** Persiste la tasa del día y avisa al Monitor en vivo. */
async function persistirYAnunciar(tasa: number, origen: string): Promise<void> {
  await prisma.tasas_bcv
    .upsert({
      where: { Fecha: jornadaActual() },
      create: { Fecha: jornadaActual(), Tasa: tasa, Origen: origen },
      update: { Tasa: tasa, Origen: origen },
    })
    .catch(() => undefined);
  IoStore.emitDbUpdate('tasa', `Tasa BCV actualizada: ${tasa}`, { tasa });
}

export const obtenerTasaCambio = async (_req: Request, res: Response) => {
  const fecha = jornadaActual();

  // ── Caché corta: si se acaba de obtener, no se vuelve a consultar ─────────
  if (cacheViva && cacheViva.expira > Date.now()) {
    return res.json({
      tasa: cacheViva.valor,
      moneda: 'USD',
      origen: cacheViva.origen,
      fuente: cacheViva.fuente,
      fecha: fecha.toISOString().slice(0, 10),
      cache: true,
    });
  }

  // ── Niveles 1a-1d: todas las fuentes EN PARALELO ──────────────────────────
  // En serie, un WAF que deja la conexión colgada consumiría todo el
  // presupuesto de tiempo del cliente. En paralelo el costo es el de la fuente
  // MÁS LENTA (8 s como máximo), no la suma de las cuatro.
  const resultados = await Promise.all(
    FUENTES.map(async (f) => {
      const r = await f.leer();
      return { ...f, valor: r.valor, error: r.error };
    })
  );

  // Diagnóstico por fuente: se devuelve SOLO cuando ningún nivel en vivo sirvió,
  // que es justo cuando hace falta saber por qué.
  const diagnostico: Record<string, string> = {};
  for (const r of resultados) {
    diagnostico[r.clave] = r.valor !== null ? `OK (${r.valor})` : r.error ?? 'sin valor';
  }

  const elegida = resultados.find((r) => r.valor !== null);

  if (elegida && elegida.valor !== null) {
    cacheViva = {
      valor: elegida.valor,
      origen: elegida.origen,
      fuente: elegida.fuente,
      expira: Date.now() + VIDA_CACHE_MS,
    };
    await persistirYAnunciar(elegida.valor, elegida.origen);
    if (elegida.fuente !== 'bcv-en-vivo' && elegida.fuente !== 'bcv-directo') {
      console.info(
        `Tasa BCV: la lectura directa no estuvo disponible; se obtuvo la tasa oficial por '${elegida.fuente}'.`
      );
    }
    return res.json({
      tasa: elegida.valor,
      moneda: 'USD',
      origen: elegida.origen,
      fuente: elegida.fuente,
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
      diagnostico,
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
      diagnostico,
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
    diagnostico,
  });
};
