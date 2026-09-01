// adrialga-backend/src/services/scraper.service.ts
import axios from 'axios';

const SCRAPER_URL = process.env.SCRAPER_SERVICE_URL || 'http://127.0.0.1:8000';

// ── Caché en memoria para la tasa BCV ────────────────────────────────────────
// Evita escrapear el sitio del BCV en cada petición: tras una respuesta exitosa
// se reutiliza el valor por 30 minutos (TTL). Reduce latencia de segundos a ms
// y evita bloqueos por rate-limiting del portal del BCV.
interface TasaCache {
  moneda: string;
  tasa: number;
  origen: string;
  fecha: Date;
}

export class ScraperService {
  private static cacheTasa: TasaCache | null = null;
  private static readonly CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutos

  static async obtenerTasaBCV() {
    // 1) Hit de caché: valor válido dentro del TTL
    if (
      this.cacheTasa &&
      Date.now() - this.cacheTasa.fecha.getTime() < this.CACHE_TTL_MS
    ) {
      return { ...this.cacheTasa, cached: true };
    }

    // 2) Miss: consulta al microservicio de scrapers (timeout acotado)
    try {
      const response = await axios.get(`${SCRAPER_URL}/api/v1/bcv/tasa`, {
        timeout: 8000
      });
      this.cacheTasa = {
        moneda: response.data.moneda ?? 'USD',
        tasa: Number(response.data.tasa),
        origen: response.data.origen ?? 'Banco Central de Venezuela',
        fecha: new Date()
      };
      return { ...this.cacheTasa, cached: false };
    } catch (error) {
      throw new Error('No se pudo obtener la tasa cambiaria del BCV');
    }
  }

  static async consultarSeniat(cedulaOrRif: string) {
    try {
      const response = await axios.get(`${SCRAPER_URL}/api/v1/seniat/consultar/${cedulaOrRif}`, {
        timeout: 8000
      });
      return response.data; // { rif: 'V280369720', nombre: '...', ... }
    } catch (error) {
      throw new Error('Error al consultar datos en SENIAT');
    }
  }
}