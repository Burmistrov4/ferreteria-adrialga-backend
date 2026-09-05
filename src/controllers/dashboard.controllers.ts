import { Request, Response } from 'express';
import { prisma } from '../config/db';
import { calcularRango, normalizarPeriodo } from '../utils/fechas';

// ── Utilidades de rango de fechas ────────────────────────────────────────────
// Las utilidades de rango de fechas (con bordes inclusivos desde/hasta) se
// centralizaron en `src/utils/fechas.ts` para su reutilización en facturas y
// reportes.

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
  const { desde, hasta, formatoSQL } = calcularRango(periodo);

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
           WHERE Fecha_Emision >= ${desde} AND Fecha_Emision <= ${hasta}
           GROUP BY etiqueta
           ORDER BY MIN(Fecha_Emision) ASC`,

        // b) Total de ventas y facturas del periodo (para ticket promedio)
        prisma.facturas.aggregate({
          _sum: { Total_General: true },
          _count: { _all: true },
          where: { Fecha_Emision: { gte: desde, lte: hasta } }
        }),

        // Ventas en Bs = Σ (Total_General × tasa_bcv_historica de cada factura)
        prisma.$queryRaw<{ montoBs: string | number | null }[]>`SELECT COALESCE(SUM(Total_General * Tasa_Cambio), 0) AS montoBs
           FROM facturas
           WHERE Fecha_Emision >= ${desde} AND Fecha_Emision <= ${hasta}`,

        // c) Desglose de caja diaria: sumatoria por método de pago desde el
        //    inicio del día (independiente del periodo seleccionado).
        prisma.pagos.groupBy({
          by: ['Metodo_Pago'],
          _sum: { Monto: true },
          where: { Fecha_Pago: { gte: calcularRango('hoy').desde } }
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

    // Top 5 productos más vendidos del periodo, por unidades vendidas.
    // (JOIN directo: prisma.groupBy no soporta columnas de tablas relacionadas)
    const topProductosRaw = await prisma.$queryRaw<
      {
        productoId: number;
        nombre: string;
        unidades: string | number | bigint;
        monto: string | number | null;
      }[]
    >`SELECT p.Producto_ID AS productoId,
             p.Nombre AS nombre,
             SUM(d.Cantidad) AS unidades,
             SUM(d.Subtotal) AS monto
      FROM detalle_facturas d
      INNER JOIN facturas f ON f.Factura_ID = d.Factura_ID
      INNER JOIN productos p ON p.Producto_ID = d.Producto_ID
      WHERE f.Fecha_Emision >= ${desde} AND f.Fecha_Emision <= ${hasta}
      GROUP BY p.Producto_ID, p.Nombre
      ORDER BY unidades DESC
      LIMIT 5`;

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
      // Rentabilidad real: margen = Σ((Precio − Costo_Histórico/CMP) × Cant),
      // costo de ventas derivado y % sobre ventas del período.
      rentabilidad: {
        margenUsd: n((margenRaw as any[])[0]?.margen),
        ventasUsd: montoTotal,
        costoVentasUsd: montoTotal - n((margenRaw as any[])[0]?.margen),
        porcentaje: montoTotal > 0
          ? Number(((n((margenRaw as any[])[0]?.margen) / montoTotal) * 100).toFixed(2))
          : 0
      },
      margenGanancia: n((margenRaw as any[])[0]?.margen),
      valorInventario: n((inventarioRaw as any[])[0]?.valor),
      cajaDiaria: cajaDiaria
        .map((c) => ({ metodo: c.Metodo_Pago, monto: n((c._sum as any)?.Monto) }))
        .sort((a, b) => b.monto - a.monto),
      alertasStock,
      topProductos: topProductosRaw.map((t) => ({
        productoId: Number(t.productoId),
        nombre: t.nombre,
        unidades: n(t.unidades),
        monto: n(t.monto)
      }))
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
        montoTotalVentas: n(ventasObj._sum?.Total_General),
        // Ventas reales en Bs (Total_General × tasa histórica de cada factura)
        montoTotalVentasBs: n((ventasBsRaw as any[])[0]?.montoBs),
        totalNotasEntrega: entradasObj._count?._all || 0,
        montoTotalEntradas: n(entradasObj._sum?.Total_Costo)
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

/**
 * GET /api/dashboard/exportar?periodo=hoy|semana|mes|anio&formato=csv|json
 *
 * Libro diario de ventas y caja del período (auditoría fiscal local):
 * una fila por factura con desglose fiscal (Subtotal/IVA/IGTF), tasa BCV
 * histórica, total en Bs y métodos de pago utilizados.
 * CSV con BOM UTF-8 para compatibilidad con Excel.
 */
export const exportarLibroDiario = async (req: Request, res: Response) => {
  const periodo = normalizarPeriodo(req.query.periodo);
  const { desde, hasta } = calcularRango(periodo);
  const formato =
    (req.query.formato ?? 'csv').toString().toLowerCase() === 'json' ? 'json' : 'csv';

  try {
    const facturas = await prisma.facturas.findMany({
      where: { Fecha_Emision: { gte: desde, lte: hasta } },
      include: {
        clientes: { select: { Razon_Social: true, RIF_Cedula: true } },
        pagos: { select: { Metodo_Pago: true, Monto: true, Es_Divisa: true } }
      },
      orderBy: { Fecha_Emision: 'asc' }
    });

    const filas = facturas.map((f) => {
      const pagosStr = f.pagos
        .map((p) => `${p.Metodo_Pago}: ${n(p.Monto).toFixed(2)}${p.Es_Divisa ? ' (USD)' : ''}`)
        .join(' | ');
      const totalBs = n(f.Total_General) * n(f.Tasa_Cambio);
      return {
        facturaId: f.Factura_ID,
        numeroControl: f.Numero_Control ?? '',
        fecha: f.Fecha_Emision.toISOString(),
        cliente: f.clientes?.Razon_Social ?? '',
        rif: f.clientes?.RIF_Cedula ?? '',
        subtotalUsd: n(f.Subtotal),
        ivaUsd: n(f.Total_IVA),
        igtfUsd: n(f.Monto_IGTF),
        totalUsd: n(f.Total_General),
        tasaBcv: n(f.Tasa_Cambio),
        totalBs: Number(totalBs.toFixed(2)),
        estatus: f.Estatus,
        metodosPago: pagosStr
      };
    });

    if (formato === 'json') {
      return res.json({
        generado: new Date().toISOString(),
        periodo,
        totalRegistros: filas.length,
        registros: filas
      });
    }

    const encabezado = [
      'Factura_ID', 'Numero_Control', 'Fecha', 'Cliente', 'RIF',
      'Subtotal_USD', 'IVA_USD', 'IGTF_USD', 'Total_USD', 'Tasa_BCV',
      'Total_Bs', 'Estatus', 'Metodos_Pago'
    ];
    const esc = (v: unknown) => {
      const s = v?.toString() ?? '';
      return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [
      encabezado.join(','),
      ...filas.map((f) =>
        [
          f.facturaId, f.numeroControl, f.fecha, f.cliente, f.rif,
          f.subtotalUsd, f.ivaUsd, f.igtfUsd, f.totalUsd, f.tasaBcv,
          f.totalBs, f.estatus, f.metodosPago
        ].map(esc).join(',')
      )
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="libro_diario_${periodo}.csv"`
    );
    return res.send('\ufeff' + csv); // BOM para Excel
  } catch (error) {
    console.error('Error al exportar el libro diario:', error);
    res.status(500).json({ message: 'Error al exportar el libro diario', error });
  }
};