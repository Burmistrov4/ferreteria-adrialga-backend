import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import authRoutes from './routes/auth.routes';
import categoriasRoutes from './routes/categorias.routes';
import productosRoutes from './routes/productos.routes';
import clientesRoutes from './routes/clientes.routes';
import proveedoresRoutes from './routes/proveedores.routes';
import notasRoutes from './routes/notas.routes';
import facturasRoutes from './routes/facturas.routes';
import dashboardRoutes from './routes/dashboard.routes';
import scrapingRoutes from './routes/scraping.routes';
import tesoreriaRoutes from './routes/tesoreria.routes';
import cajaRoutes from './routes/caja.routes';
import seniatRoutes from './routes/seniat.routes';
import { obtenerTasaCambio } from './controllers/tasa.controllers';
import { getHealth } from './controllers/health.controllers';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ── Seguridad: headers HTTP seguros (X-Content-Type, X-Frame, HSTS, etc.) ──
app.use(helmet());

// ── CORS restringido: solo orígenes permitidos ──
const ALLOWED_ORIGINS = [
  'https://adrialga.vercel.app',          // Frontend producción (Vercel)
  'https://adrialga-frontend.vercel.app', // Alias alternativo
  'http://localhost:3000',                // Desarrollo local Flutter web
  'http://localhost:5173',                // Vite dev
];

// En desarrollo se permite CUALQUIER origen localhost (Flutter web usa un
// puerto dinámico 5xxxx). En producción la lista sigue siendo estricta.
const esDesarrollo = (process.env.NODE_ENV ?? 'development') !== 'production';
const esOrigenLocalDev = (origin: string) =>
  esDesarrollo &&
  (origin.startsWith('http://localhost:') || origin.startsWith('http://127.0.0.1:'));

app.use(cors({
  origin: (origin, callback) => {
    // Permitir peticiones sin origen (apps móviles, Postman, curl)
    if (!origin) return callback(null, true);
    if (esOrigenLocalDev(origin) || ALLOWED_ORIGINS.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error(`CORS: origen no permitido: ${origin}`));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ── Rate limiting global: 100 peticiones / 15 min por IP ──
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas peticiones. Intenta de nuevo en 15 minutos.' },
});
app.use('/api/', limiter);

// ── Rate limiting estricto para auth (prevenir fuerza bruta) ──
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Demasiados intentos de inicio de sesión. Intenta en 15 minutos.' },
});
app.use('/api/auth/login', authLimiter);

app.use(express.json());

// Ruta base para comprobación en el navegador
app.get('/', (req, res) => {
  res.json({ status: 'OK', message: 'API Backend Adrialga conectada y operativa' });
});

// Tasa de cambio BCV en vivo (scraper Python + persistencia en tasas_bcv)
app.get('/api/tasa-cambio', obtenerTasaCambio);

// Rutas de autenticación
app.use('/api/auth', authRoutes);

// Rutas de categorías
app.use('/api/categorias', categoriasRoutes);
// Rutas de productos
app.use('/api/productos', productosRoutes);
// Rutas de clientes
app.use('/api/clientes', clientesRoutes);
// Rutas de proveedores
app.use('/api/proveedores', proveedoresRoutes);
// Rutas de notas de entrega
app.use('/api/notas', notasRoutes);
// Rutas de facturas y entradas de inventario
app.use('/api/facturas', facturasRoutes);
app.use('/api/dashboard', dashboardRoutes);
// Rutas de scraping (proxy al microservicio Python)
app.use('/api/scraping', scrapingRoutes);
// Rutas de tesorería, caja y cuentas por pagar
app.use('/api/tesoreria', tesoreriaRoutes);
// Rutas de apertura/cierre de caja (arqueo, turnos)
app.use('/api/caja', cajaRoutes);
// Rutas de reportes fiscales SENIAT (libro de ventas, compras, resumen IVA)
app.use('/api/seniat', seniatRoutes);

// Healthcheck de producción (sin auth, consulta liviana SELECT 1 a MySQL)
app.get('/api/health', getHealth);

// Inicio del servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor ejecutándose en http://localhost:${PORT}`);
});
