// adrialga-backend/src/services/scraper.service.ts
import axios from 'axios';

const SCRAPER_URL = process.env.SCRAPER_SERVICE_URL || 'http://127.0.0.1:8000';

export class ScraperService {
  static async obtenerTasaBCV() {
    try {
      const response = await axios.get(`${SCRAPER_URL}/api/v1/bcv/tasa`);
      return response.data; // { moneda: 'USD', tasa: 36.50, origen: '...' }
    } catch (error) {
      throw new Error('No se pudo obtener la tasa cambiaria del BCV');
    }
  }

  static async consultarSeniat(cedulaOrRif: string) {
    try {
      const response = await axios.get(`${SCRAPER_URL}/api/v1/seniat/consultar/${cedulaOrRif}`);
      return response.data; // { rif: 'V280369720', nombre: '...', ... }
    } catch (error) {
      throw new Error('Error al consultar datos en SENIAT');
    }
  }
}