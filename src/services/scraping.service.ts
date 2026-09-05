// adrialga-backend/src/services/scraping.service.ts
// Cliente HTTP hacia el microservicio Python-Scrappers (FastAPI).
// Todas las peticiones llevan la cabecera X-API-Key validada por el
// microservicio (ver Python-Scrappers/app/core/security.py).
import axios, { AxiosError } from 'axios';
import { z } from 'zod';

const SCRAPING_SERVICE_URL =
  process.env.SCRAPING_SERVICE_URL || 'http://localhost:8000';
const SCRAPING_API_KEY = process.env.SCRAPING_API_KEY || '';

// ── Esquemas Zod (espejo de Python-Scrappers/app/schemas/proveedores.py) ────
export const PrecioProveedorSchema = z.object({
  proveedor: z.string(),
  sku_proveedor: z.string(),
  descripcion: z.string().optional().nullable(),
  precio_usd: z.number(),
  moneda_original: z.string(),
  disponibilidad: z.boolean(),
  url_producto: z.string().optional().nullable(),
  fecha: z.string(),
});

export const RespuestaScrapingSchema = z.object({
  status: z.string(),
  ejecutado_en: z.string(),
  total_items: z.number(),
  actualizados: z.number(),
  errores: z.array(
    z.object({
      sku_proveedor: z.string(),
      motivo: z.string(),
    }).passthrough()
  ),
  items: z.array(PrecioProveedorSchema),
});

export type PrecioProveedor = z.infer<typeof PrecioProveedorSchema>;
export type RespuestaScraping = z.infer<typeof RespuestaScrapingSchema>;

// Cliente axios preconfigurado: base URL + cabecera de API Key inter-servicio
const client = axios.create({
  baseURL: SCRAPING_SERVICE_URL,
  timeout: 30000, // los scrapers reales pueden tardar; margen amplio
  headers: SCRAPING_API_KEY ? { 'X-API-Key': SCRAPING_API_KEY } : {},
});

/** Traduce errores de axios a un mensaje controlado y legible. */
function describirError(error: unknown, contexto: string): Error {
  if (error instanceof AxiosError) {
    if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT' || !error.response) {
      return new Error(
        `${contexto}: el microservicio de scraping no está disponible (${SCRAPING_SERVICE_URL})`
      );
    }
    if (error.response.status === 401) {
      return new Error(
        `${contexto}: rechazado por el microservicio (X-API-Key ausente o inválida)`
      );
    }
    return new Error(
      `${contexto}: el microservicio respondió ${error.response.status}`
    );
  }
  return new Error(`${contexto}: error inesperado`);
}

export class ScrapingService {
  /**
   * Obtiene la tasa de cambio del BCV desde el microservicio.
   * Nota: en producción esta ruta NO requiere API Key (solo /proveedores/*).
   * Ante fallo del servicio lanza un error controlado — el llamador decide
   * si usa un fallback (ej. última tasa persistida en BD).
   */
  static async obtenerTasaBCV(): Promise<{
    moneda: string;
    tasa: number;
    origen?: string;
  }> {
    try {
      const { data } = await client.get('/api/v1/bcv/tasa');
      return {
        moneda: data.moneda ?? 'USD',
        tasa: Number(data.tasa),
        origen: data.origen,
      };
    } catch (error) {
      throw describirError(error, 'Consulta BCV');
    }
  }

  /**
   * Dispara el scraping de precios de proveedores.
   * @param objetivos Lista opcional de SKUs/URLs a scrapear; vacío = todos.
   * @returns RespuestaScraping validada con Zod (shape espejo del esquema Pydantic).
   */
  static async ejecutarScrapingProveedores(
    objetivos?: string[]
  ): Promise<RespuestaScraping> {
    try {
      const { data } = await client.post(
        '/api/v1/scrapers/proveedores/ejecutar',
        { objetivos: objetivos ?? null }
      );
      const parsed = RespuestaScrapingSchema.safeParse(data);
      if (!parsed.success) {
        throw new Error(
          `Respuesta del microservicio con shape inesperado: ${parsed.error.message}`
        );
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Respuesta')) throw error;
      throw describirError(error, 'Scraping de proveedores');
    }
  }

  /**
   * Consulta los datos fiscales de un contribuyente en el SENIAT.
   * @returns { rif, nombre, es_contribuyente_especial, ... }
   */
  static async consultarSeniat(cedulaOrRif: string) {
    try {
      const { data } = await client.get(
        `/api/v1/seniat/consultar/${encodeURIComponent(cedulaOrRif)}`,
        { timeout: 8000 }
      );
      return data;
    } catch (error) {
      if (error instanceof AxiosError && error.response) {
        // Propagar el detalle del SENIAT (404 no encontrado, 503 caído, etc.)
        const detail =
          (error.response.data as { detail?: string } | undefined)?.detail ??
          'No se pudo consultar el SENIAT';
        throw Object.assign(new Error(detail), {
          statusCode: error.response.status,
        });
      }
      throw describirError(error, 'Consulta SENIAT');
    }
  }
}
