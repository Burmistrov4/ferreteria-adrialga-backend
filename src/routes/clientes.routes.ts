// adrialga-backend/src/routes/clientes.routes.ts
import { Router } from 'express';
import {
  getClientes,
  createCliente,
  updateCliente,
  deleteCliente,
  buscarClientePorDocumento
} from '../controllers/clientes.controllers';
import { authenticateToken } from '../middlewares/auth.middleware';
import { ScrapingService } from '../services/scraping.service';

const router = Router();

// Rutas públicas (BCV y Consulta SENIAT)
router.get('/bcv-rate', async (req, res) => {
  try {
    const data = await ScrapingService.obtenerTasaBCV();
    return res.json(data);
  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
});

router.get('/consultar-cliente/:cedula', async (req, res) => {
  try {
    const data = await ScrapingService.consultarSeniat(req.params.cedula);
    return res.json(data);
  } catch (error: any) {
    return res
      .status(error.statusCode ?? 404)
      .json({ error: error.message });
  }
});

// Middleware de autenticación para las rutas protegidas de la BD
router.use(authenticateToken);

router.get('/', getClientes);
router.get('/buscar', buscarClientePorDocumento);
router.post('/', createCliente);
router.put('/:id', updateCliente);
router.delete('/:id', deleteCliente);

export default router;