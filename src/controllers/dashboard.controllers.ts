import { Request, Response } from 'express';
import { prisma } from '../config/db';

export const getDashboardMetrics = async (_req: Request, res: Response) => {
  try {
    const [
      totalProductos,
      todosLosProductos,
      totalClientes,
      totalProveedores,
      resumenVentas,
      resumenEntradas
    ] = await Promise.all([
      // 1. Total de productos activos
      prisma.productos.count({ where: { Activo: true } }),

      // 2. Obtener productos activos para evaluar stock mínimo
      prisma.productos.findMany({
        where: { Activo: true },
        include: { categorias: true }
      }),

      // 3. Totales de clientes y proveedores
      prisma.clientes.count(),
      prisma.proveedores.count(),

      // 4. Suma total y conteo de facturas (Ventas)
      prisma.facturas.aggregate({
        _sum: { Total_General: true },
        _count: { _all: true }
      }),

      // 5. Suma total y conteo de notas de entrega (Compras)
      prisma.notas_entrega_entrada.aggregate({
        _sum: { Total_Costo: true },
        _count: { _all: true }
      })
    ]);

    // Filtrar productos con stock actual menor o igual al mínimo
    const productosBajoStock = todosLosProductos.filter(
      (prod) => prod.Stock_Actual <= prod.Stock_Minimo
    );

    // Extraer valores de forma segura evitando problemas de tipado en Prisma
    const ventasObj = resumenVentas as any;
    const entradasObj = resumenEntradas as any;

    res.json({
      resumen: {
        totalProductos,
        totalClientes,
        totalProveedores,
        totalFacturas: ventasObj._count?._all || 0,
        montoTotalVentas: ventasObj._sum?.Total_General || 0,
        totalNotasEntrega: entradasObj._count?._all || 0,
        montoTotalEntradas: entradasObj._sum?.Total_Costo || 0
      },
      alertas: {
        conteoStockBajo: productosBajoStock.length,
        productosBajoStock
      }
    });
  } catch (error) {
    console.error('Error al generar métricas del dashboard:', error);
    res.status(500).json({ message: 'Error al obtener métricas del dashboard', error });
  }
};