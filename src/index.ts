import express from 'express';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import http from 'http';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { Server } from 'socket.io';
import dotenv from 'dotenv';
import jwt from 'jsonwebtoken';
import { IoStore } from './utils/socket';
import { esOrigenPermitido } from './utils/cors';
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
import usuariosRoutes from './routes/usuarios.routes';
import seniatRoutes from './routes/seniat.routes';
import pagosRoutes from './routes/pagos.routes';
import configuracionRoutes from './routes/configuracion.routes';
import monitorRoutes from './routes/monitor.routes';
import { obtenerTasaCambio } from './controllers/tasa.controllers';
import { getHealth } from './controllers/health.controllers';

dotenv.config();

// ── Fail-closed de seguridad: sin JWT_SECRET los tokens serían forjables ──
// El `|| 'secret'` por defecto en el middleware de auth es inaceptable en
// cualquier entorno (producción o no). Se aborta el arranque si falta.
if (!process.env.JWT_SECRET) {
  console.error(
    'FATAL: JWT_SECRET no está definido en el entorno. ' +
      'Los tokens JWT serían firma-verificables con una clave pública conocida. ' +
      'Abortando el arranque.',
  );
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3000;

// ── Seguridad: headers HTTP seguros ─────────────────────────────────────────
// El CSP por defecto de Helmet ('default-src self' / 'script-src self') BLOQUEA
// el arranque del renderer CanvasKit de Flutter Web, que carga su motor WASM
// desde el CDN de gstatic y lo compila en runtime (requiere 'wasm-unsafe-eval').
// Resultado: el motor no arrancaba y la app quedaba en PANTALLA BLANCA.
// Se declara un CSP explícito compatible con Flutter Web.
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        defaultSrc: ["'self'"],
        // 'wasm-unsafe-eval' → WebAssembly.compile del motor CanvasKit.
        // 'unsafe-inline'     → estilos/arranque que inyecta Flutter.
        // gstatic            → motor CanvasKit (canvaskit.js / .wasm).
        scriptSrc: [
          "'self'",
          "'wasm-unsafe-eval'",
          "'unsafe-inline'",
          'https://www.gstatic.com',
        ],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
        connectSrc: [
          "'self'",
          'https://www.gstatic.com',
          'https://fonts.gstatic.com',
          'https://fonts.googleapis.com',
        ],
        workerSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        frameAncestors: ["'self'"],
        // La demo corre sobre HTTP en LAN; 'upgrade-insecure-requests' rompería
        // las llamadas a http://<IP>:3000/api. Se desactiva.
        upgradeInsecureRequests: null,
      },
    },
    // CanvasKit se sirve cross-origin (gstatic): COEP estricto lo bloquearía.
    crossOriginEmbedderPolicy: false,
  }),
);

// ── CORS restringido: solo orígenes permitidos ──
// El validador de origen vive en src/utils/cors.ts (compartido con Socket.io) y
// es verificado por scripts/test_cors_validator.ts. Socket.io usa el mismo
// validador (ver bloque WebSocket más abajo).
//
// Se construye una instancia POR PETICIÓN porque la decisión depende de la
// cabecera `Host`: una petición del MISMO origen (la web que sirve este mismo
// backend) no es una petición CORS y debe aceptarse en cualquier IP o dominio
// sin configurar nada.
//
// Un origen no permitido se deniega EN SILENCIO, sin cabeceras CORS: el
// navegador bloquea la lectura y el síntoma es un error CORS claro. Antes se
// lanzaba un Error y, en producción sobre IP o dominio propio, eso convertía
// CADA POST (login, ventas, caja) en un 500 indistinguible de una caída del
// servidor. Medido y corregido el 2026-10-15.
app.use((req, res, next) => {
  cors({
    origin: (origin, callback) => {
      callback(null, esOrigenPermitido(origin, req.headers.host));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    // X-Total-Count permite a Flutter Web paginar /api/productos sin una
    // segunda petición de conteo (sin esto el navegador oculta la cabecera).
    exposedHeaders: ['X-Total-Count'],
  })(req, res, next);
});

// ── Proxy inverso: Render (y cualquier PaaS) termina TLS delante del proceso.
// Sin esto, `req.ip` es SIEMPRE la IP del proxy y el rate limit "por IP" se
// vuelve un límite GLOBAL: un atacante agota el bucket del login y deja fuera a
// todos los usuarios. `1` = confiar en el primer proxy de la plataforma.
// Medido el 2026-10-16.
app.set('trust proxy', 1);

// ── Rate limiting global: uso intensivo durante toda la jornada y varios dispositivos LAN ──
// Flutter Web consulta varios módulos y los equipos de una LAN pueden compartir IP.
// Este límite alto evita bloquear el uso normal; no sustituye el diagnóstico de bucles
// de peticiones. Se conserva el límite estricto específico de autenticación.
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas peticiones. Intenta de nuevo en 15 minutos.' },
});
app.use('/api/', limiter);

// ── Rate limiting estricto para auth (prevenir fuerza bruta) ──
// Con `trust proxy` activo, el límite ya es por IP real (antes era global y un
// atacante podía bloquear el login de todos). 30 permite el uso normal de una
// LAN compartida sin abrir la puerta a la fuerza bruta.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: 'Demasiados intentos de inicio de sesión. Intenta en 15 minutos.' },
});
app.use('/api/auth/login', authLimiter);

// Límite de tamaño de cuerpo: mitiga abuso de memoria por payloads enormes.
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ── Compresión de respuestas ───────────────────────────────────────────────
// La build de Flutter Web pesa ~12 MB sin comprimir (main.dart.js 5,1 MB +
// canvaskit.wasm 7,3 MB). Servida en crudo, la PRIMERA carga sobre LAN/hotspot
// tardaba muchísimo (medido el 2026-10-14). Con gzip baja a ~1/3: es la
// diferencia entre esperar y no esperar en la exposición.
//
// El umbral de 1 KB evita comprimir respuestas diminutas (peor rendimiento que
// enviarlas tal cual). No se comprime lo que ya viene comprimido: el filtro
// `Content-Type` de `compression` omite imágenes y vídeos.
app.use(
  compression({
    threshold: 1024,
    // Nivel 6: buen equilibrio entre CPU y tamaño en el servidor de la demo.
    level: 6,
  })
);

// ── Imágenes de productos (catálogo EPA importado localmente) ──────────────
// El scraper de B1 descarga el original a public/productos/{sku}.jpg y el
// campo Imagen_URL guarda la ruta relativa /productos/{sku}.jpg. Se sirve sin
// depender del CDN externo de EPA (mayor velocidad en el POS y tolerancia a
// caídas de la web de origen).
//
// PRODUCTOS_DIR permite apuntar a un volumen montado (contenedor / VPS) sin
// recompilar: el catálogo completo pesa ~177 MB y solo se despliega el
// subconjunto que el sistema realmente muestra.
const rutaImagenesProductos = process.env.PRODUCTOS_DIR
  ? path.resolve(process.env.PRODUCTOS_DIR)
  : path.resolve(__dirname, '../public/productos');
if (!fs.existsSync(rutaImagenesProductos)) {
  fs.mkdirSync(rutaImagenesProductos, { recursive: true });
  console.log(`📦 Carpeta de imágenes de productos creada: ${rutaImagenesProductos}`);
}
app.use('/productos', express.static(rutaImagenesProductos));

// ── Servido de la build de Flutter (despliegue unificado desde Node) ────────
// Sirve el frontend compilado SIN fusionar carpetas: apunta a la carpeta
// HERMANA `adrialga_frontend/build/web`. Cualquier ruta no-API delega el
// enrutamiento a Flutter (SPA fallback → index.html). Un único `npm start`
// entrega API + frontend en el mismo puerto :3000.
//
// WEB_ROOT es imprescindible en un despliegue de SOLO backend (PaaS o
// contenedor): sin la variable, la ruta relativa al monorepo resuelve FUERA de
// la aplicación y la web no se sirve, aunque la build exista.
const rutaWebFlutter = process.env.WEB_ROOT
  ? path.resolve(process.env.WEB_ROOT)
  : path.resolve(__dirname, '../../adrialga_frontend/build/web');
const buildFlutterExiste = fs.existsSync(rutaWebFlutter);

if (buildFlutterExiste) {
  // Los archivos de ENTRADA de la SPA no llevan hash en el nombre, así que el
  // navegador (y sobre todo el service worker de Flutter) puede seguir sirviendo
  // la versión ANTERIOR después de recompilar — el síntoma es "recompilé y veo
  // exactamente el mismo diseño de siempre". Se fuerza revalidación en cada
  // carga para esos cuatro archivos; el resto se cachea con normalidad.
  const SIN_CACHE = new Set([
    'index.html',
    'flutter_bootstrap.js',
    'flutter_service_worker.js',
    'version.json',
    'manifest.json',
  ]);
  app.use(
    express.static(rutaWebFlutter, {
      setHeaders: (res, filePath) => {
        if (SIN_CACHE.has(path.basename(filePath))) {
          res.setHeader('Cache-Control', 'no-cache, must-revalidate');
        }
      },
    })
  );
  console.log(`🖥️  Frontend Flutter servido desde: ${rutaWebFlutter}`);
} else {
  console.warn(
    `⚠  Build de Flutter no encontrada en ${rutaWebFlutter}. ` +
      `Ejecuta "flutter build web" en adrialga_frontend para el modo unificado.`,
  );
}

// Ruta base '/':
//  - Si el frontend está compilado → entrega index.html (la SPA maneja el
//    enrutamiento del lado cliente). Al abrir http://<IP>:3000/ se ve el
//    frontend, NO el JSON de estado de la API.
//  - Si NO hay build → entrega el JSON de estado (modo solo-backend).
app.get('/', (req, res) => {
  if (buildFlutterExiste) {
    return res.sendFile(path.join(rutaWebFlutter, 'index.html'));
  }
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
// Gestión de usuarios (CRUD protegido: el root es intocable)
app.use('/api/usuarios', usuariosRoutes);
// Rutas de reportes fiscales SENIAT (libro de ventas, compras, resumen IVA)
app.use('/api/seniat', seniatRoutes);
// Rutas del motor de pagos mixtos con precisión decimal (decimal.js)
app.use('/api/pagos', pagosRoutes);
// Datos legales de la tienda (encabezado PDF, tickets térmicos)
app.use('/api/configuracion', configuracionRoutes);
// Monitor de la base de datos (esquema en vivo para el modo presentación)
app.use('/api/monitor', monitorRoutes);

// Healthcheck de producción (sin auth, consulta liviana SELECT 1 a MySQL)
app.get('/api/health', getHealth);

// Catch-all SPA: cualquier ruta no-API/no-WS delega el enrutamiento a Flutter
// (index.html). Solo se registra si existe la build; el guard evita tapar la
// API (/api) y el canal WebSocket (/socket.io).
if (buildFlutterExiste) {
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/socket.io')) {
      return next();
    }
    res.sendFile(path.join(rutaWebFlutter, 'index.html'));
  });
}

// ── WebSocket (Socket.io) — sincronización real-time entre dispositivos ────
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    // Mismo origen permitido que HTTP CORS (esOrigenPermitido). El cliente
    // web se sirve desde este mismo servidor, así que no hay razón para
    // aceptar cualquier origen en el canal WebSocket.
    origin: (origin, callback) => callback(null, esOrigenPermitido(origin)),
    methods: ['GET', 'POST'],
    credentials: true,
  },
});

// Socket.IO comparte la sesión JWT de la API. Sin este middleware cualquier
// equipo conectado a la LAN podía suscribirse a eventos de negocio sin iniciar
// sesión y leer mensajes de ventas, caja o usuarios.
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (typeof token !== 'string' || token.length === 0) {
    return next(new Error('No autorizado: falta token de sesión'));
  }
  try {
    jwt.verify(token, process.env.JWT_SECRET!);
    return next();
  } catch {
    return next(new Error('No autorizado: token inválido o expirado'));
  }
});

// Se almacena para uso desde los controllers (sin ciclo de importaciones)
IoStore.init(io);

io.on('connection', (socket) => {
  console.log(`📡 Cliente WebSocket conectado: ${socket.id}`);
  socket.on('disconnect', () => {
    console.log(`📡 Cliente WebSocket desconectado: ${socket.id}`);
  });
});

// Inicio del servidor HTTP+WebSocket
const obtenerIPsLan = (): string[] =>
  Object.values(os.networkInterfaces())
    .flatMap((interfaces) => interfaces ?? [])
    .filter((info) => info.family === 'IPv4' && !info.internal)
    .map((info) => info.address);

server.listen(Number(PORT), '0.0.0.0', () => {
  console.log(`🚀 Servidor ejecutándose en http://localhost:${PORT}`);
  const ipsLan = obtenerIPsLan();
  if (ipsLan.length > 0) {
    ipsLan.forEach((ip) => console.log(`🌐 Acceso de red local: http://${ip}:${PORT}`));
  } else {
    console.log('🌐 No se detectó una IP IPv4 de red local automáticamente.');
  }
  console.log(`📡 WebSocket habilitado (socket.io en ruta /socket.io)`);
});
