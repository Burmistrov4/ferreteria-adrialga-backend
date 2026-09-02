import { Request, Response } from 'express';
import { prisma } from '../config/db';

// ── Utilidades de rango de fechas ────────────────────────────────────────────
type Periodo = 'hoy' | 'semana' | 'mes' | 'anio';

function inicioDelDia(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}

function calcularRango(periodo: Periodo): { desde: Date; formatoSQL: string } {
  const ahora = new Date();
  switch (periodo) {
    case 'hoy': {
      // Serie por HORA del día actual
      return { desde: inicioDelDia(), formatoSQL: '%H:00' };
    }
    case 'semana': {
      const d = inicioDelDia();
      d.setDate(d.getDate() - 6); // últimos 7 días, serie por DÍA
      return { desde: d, formatoSQL: '%Y-%m-%d' };
    }
    case 'mes': {
      const d = inicioDelDia();
      d.setDate(1); // mes en curso, serie por DÍA
      return { desde: d, formatoSQL: '%Y-%m-%d' };
    }
    case 'anio': {
      const d = new Date(ahora.getFullYear(), 0, 1); // año en curso, serie por MES
      return { desde: d, formatoSQL: '%Y-%m' };
    }
  }
}

function normalizarPeriodo(valor: unknown): Periodo {
  const p = String(valor ?? 'hoy').toLowerCase();
  return (['hoy', 'semana', 'mes', 'anio'] as const).includes(p as Periodo)
    ? (p as Periodo)
    : 'hoy';
}

const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

/**
 * GET /api/dashboard/serie?periodo=hoy|semana|mes|anio
 *
 * Métricas financieras del rango seleccionado, en una sola respuesta:
 *  - serie de ventas agregada (por hora / día / mes según el periodo)
 *  - total de ventas, cantidad de facturas y ticket promedio
 *  - desglose de caja diaria por método de pago (tabla `pagos`)
 *  - margen de ganancia histórico: SUM((Precio_Unitario - Costo_Unitario_Historico) * Cantidad)
 *  - valoración de inventario: SUM(Stock_Actual * Costo_Promedio)
 *  - alertas de stock bajo
 *
 * Las agregaciones por fecha truncada y los productos entre columnas no son
 * soportados por prisma.groupBy, por lo que se resuelven con $queryRaw
 * parametrizado (seguro contra inyección SQL).
 */
export const getSerieFinanciera = async (req: Request, res: Response) => {
  const periodo = normalizarPeriodo(req.query.periodo);
  const { desde, formatoSQL } = calcularRango(periodo);

  try {
    const [serieVentas, agregadoVentas, ventasBsRaw, cajaDiaria, margenRaw, inventarioRaw, productosBajoStock] =
      await Promise.all([
        // a) Serie de ventas agregada por hora/día/mes (USD y Bs con la tasa histórica)
        prisma.$queryRaw<
          { etiqueta: string; monto: string | number; montoBs: string | number; facturas: number }[]
        >`SELECT DATE_FORMAT(Fecha_Emision, ${formatoSQL}) AS etiqueta,
                  COALESCE(SUM(Total_General), 0) AS monto,
                  COALESCE(SUM(Total_General * Tasa_Cambio), 0) AS montoBs,
                  COUNT(*) AS facturas
           FROM facturas
           WHERE Fecha_Emision >= ${desde}
           GROUP BY etiqueta
           ORDER BY MIN(Fecha_Emision) ASC`,

        // b) Total de ventas y facturas del periodo (para ticket promedio)
        prisma.facturas.aggregate({
          _sum: { Total_General: true },
          _count: { _all: true },
          where: { Fecha_Emision: { gte: desde } }
        }),

        // Ventas en Bs = Σ (Total_General × tasa_bcv_historica de cada factura)
        prisma.$queryRaw<{ montoBs: string | number | null }[]>`SELECT COALESCE(SUM(Total_General * Tasa_Cambio), 0) AS montoBs
           FROM facturas
           WHERE Fecha_Emision >= ${desde}`,

        // c) Desglose de caja diaria: sumatoria por método de pago desde el
        //    inicio del día (independiente del periodo seleccionado).
        prisma.pagos.groupBy({
          by: ['Metodo_Pago'],
          _sum: { Monto: true },
          where: { Fecha_Pago: { gte: inicioDelDia() } }
        }),

        // d) Margen de ganancia histórico del periodo
        prisma.$queryRaw<{ margen: string | number | null }[]>`SELECT COALESCE(SUM((df.Precio_Unitario - df.Costo_Unitario_Historico) * df.Cantidad), 0) AS margen
           FROM detalle_facturas df
           INNER JOIN facturas f ON f.Factura_ID = df.Factura_ID
           WHERE f.Fecha_Emision >= ${desde}`,

        // e) Valoración total del inventario activo (sin filtro de periodo)
        prisma.$queryRaw<{ valor: string | number | null }[]>`SELECT COALESCE(SUM(Stock_Actual * Costo_Promedio), 0) AS valor
           FROM productos
           WHERE Activo = 1`,

        prisma.productos.findMany({
          where: { Activo: true },
          select: {
            Producto_ID: true,
            SKU_Codigo: true,
            Nombre: true,
            Stock_Actual: true,
            Stock_Minimo: true
          }
        })
      ]);

    const alertasStock = productosBajoStock
      .filter((p) => p.Stock_Actual <= p.Stock_Minimo)
      .sort((a, b) => a.Stock_Actual - b.Stock_Actual);

    const montoTotal = n((agregadoVentas._sum as any)?.Total_General);
    const montoTotalBs = n((ventasBsRaw as any[])[0]?.montoBs);
    const cantidadFacturas = n((agregadoVentas as any)?._count?._all);
    const ticketPromedio = cantidadFacturas > 0 ? montoTotal / cantidadFacturas : 0;
    const ticketPromedioBs = cantidadFacturas > 0 ? montoTotalBs / cantidadFacturas : 0;

    res.json({
      periodo,
      serie: serieVentas.map((f) => ({
        etiqueta: f.etiqueta,
        monto: n(f.monto),
        montoBs: n(f.montoBs),
        facturas: Number(f.facturas)
      })),
      ventas: {
        montoTotal,
        montoTotalBs,
        cantidadFacturas,
        ticketPromedio,
        ticketPromedioBs
      },
      margenGanancia: n((margenRaw as any[])[0]?.margen),
      valorInventario: n((inventarioRaw as any[])[0]?.valor),
      cajaDiaria: cajaDiaria
        .map((c) => ({ metodo: c.Metodo_Pago, monto: n((c._sum as any)?.Monto) }))
        .sort((a, b) => b.monto - a.monto),
      alertasStock
    });
  } catch (error) {
    console.error('Error al generar la serie financiera del dashboard:', error);
    res.status(500).json({ message: 'Error al obtener la serie financiera', error });
  }
};

export const getDashboardMetrics = async (_req: Request, res: Response) => {
  try {
    const [
      totalProductos,
      todosLosProductos,
      totalClientes,
      totalProveedores,
      resumenVentas,
      resumenEntradas,
      ventasBsRaw
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

      // 4. Suma total y conteo de facturas (Ventas en USD)
      prisma.facturas.aggregate({
        _sum: { Total_General: true },
        _count: { _all: true }
      }),

      // 5. Suma total y conteo de notas de entrega (Compras)
      prisma.notas_entrega_entrada.aggregate({
        _sum: { Total_Costo: true },
        _count: { _all: true }
      }),

      // 6. Ventas reales en Bs = Σ (Total_General × tasa_bcv_historica)
      prisma.$queryRaw<{ montoBs: string | number | null }[]>`SELECT COALESCE(SUM(Total_General * Tasa_Cambio), 0) AS montoBs FROM facturas`
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
        // Ventas en USD (suma directa de Total_General)
        montoTotalVentas: ventasObj._sum?.Total_General || 0,
        // Ventas reales en Bs (Total_General × tasa histórica de cada factura)
        montoTotalVentasBs: n((ventasBsRaw as any[])[0]?.montoBs),
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