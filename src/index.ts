import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import authRoutes from './routes/auth.routes';
import categoriasRoutes from './routes/categorias.routes';
import productosRoutes from './routes/productos.routes';
import clientesRoutes from './routes/clientes.routes';
import proveedoresRoutes from './routes/proveedores.routes';
import notasRoutes from './routes/notas.routes';
import facturasRoutes from './routes/facturas.routes';
import dashboardRoutes from './routes/dashboard.routes';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json());

// Ruta base para comprobación en el navegador
app.get('/', (req, res) => {
  res.json({ status: 'OK', message: 'API Backend Adrialga conectada y operativa' });
});

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
// Rutas de facturas
app.use('/api/facturas', facturasRoutes);
// Rutas del dashboard
app.use('/api/dashboard', dashboardRoutes);
// Inicio del servidor
app.listen(PORT, () => {
  console.log(`🚀 Servidor ejecutándose en http://localhost:${PORT}`);
});