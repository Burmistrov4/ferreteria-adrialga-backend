import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { calcularRango, normalizarPeriodo } from '../utils/fechas';
import { responderErrorPrisma } from '../utils/errores';
import { toD4, aDecimal, addD4, subD4 } from '../utils/dinero';
import { esEfectivo } from '../utils/caja';
import { evaluarArqueo } from '../utils/arqueo';

// ── Utilidades de rango de fechas ────────────────────────────────────────────
// Las utilidades de rango de fechas (con bordes inclusivos desde/hasta) se
// centralizaron en `src/utils/fechas.ts` para su reutilización en facturas y
// reportes.

const n = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));

interface NotificacionesPayload {
  total: number;
  conteo: {
    critico: number;
    atencion: number;
    positivo: number;
  };
  insights: Insight[];
}

const NOTIFICACIONES_CACHE_MS = 30_000;
let notificacionesCache: { expiresAt: number; payload: NotificacionesPayload } | null = null;

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
  const periodo = normalizarPeriodo(req.query.periodo ?? req.query.rango);
  const { desde, hasta, formatoSQL } = calcularRango(periodo);
  // Ventana analítica de 30 días para el Asistente (rotación, muerto, margen).
  const desde30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  try {
    const [serieVentas, resumenVentas, cajaDiaria, margenRaw, inventarioRaw, productosBajoStock, idsBajoStockRaw, inventarioMuertoRaw, alertasMargenRaw, rotacionRaw] =
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
             AND (Tipo_Documento IS NULL OR Tipo_Documento = 'FACTURA')
           GROUP BY etiqueta
           ORDER BY MIN(Fecha_Emision) ASC`,

        // b) Totales del período en una sola lectura de facturas.
        prisma.$queryRaw<{
          monto: string | number | null;
          montoBs: string | number | null;
          facturas: number | bigint;
        }[]>`SELECT
              COALESCE(SUM(Total_General), 0) AS monto,
              COALESCE(SUM(Total_General * Tasa_Cambio), 0) AS montoBs,
              COUNT(*) AS facturas
           FROM facturas
           WHERE Fecha_Emision >= ${desde} AND Fecha_Emision <= ${hasta}
             AND (Tipo_Documento IS NULL OR Tipo_Documento = 'FACTURA')`,

        // c) Desglose de caja diaria: sumatoria por método de pago desde el
        //    inicio del día (independiente del periodo seleccionado).
        prisma.pagos.groupBy({
          by: ['Metodo_Pago'],
          _sum: { Monto: true },
          where: { Fecha_Pago: { gte: calcularRango('hoy').desde } }
        }),

        // d) Margen de ganancia del periodo.
        prisma.$queryRaw<{ margen: string | number | null }[]>`SELECT COALESCE(SUM((df.Precio_Unitario - df.Costo_Unitario_Historico) * df.Cantidad), 0) AS margen
           FROM detalle_facturas df
           INNER JOIN facturas f ON f.Factura_ID = df.Factura_ID
           WHERE f.Fecha_Emision >= ${desde} AND f.Fecha_Emision <= ${hasta}
             AND (f.Tipo_Documento IS NULL OR f.Tipo_Documento = 'FACTURA')`,

        // e) Valoración total del inventario activo (sin filtro de periodo)
        prisma.$queryRaw<{ valor: string | number | null }[]>`SELECT COALESCE(SUM(Stock_Actual * Costo_Promedio), 0) AS valor
           FROM productos
           WHERE Activo = 1`,

        // Solo se transportan los productos que realmente disparan la alerta.
        prisma.$queryRaw<{
          Producto_ID: number;
          SKU_Codigo: string;
          Nombre: string;
          Stock_Actual: number;
          Stock_Minimo: number;
        }[]>`SELECT Producto_ID, SKU_Codigo, Nombre, Stock_Actual, Stock_Minimo
          FROM productos
          WHERE Activo = 1 AND Stock_Actual <= Stock_Minimo
          ORDER BY Stock_Actual ASC
          LIMIT 5`,

        // IDs completos para precarga de EntradasScreen. Se transportan solo enteros,
        // no el objeto completo de cada producto.
        prisma.$queryRaw<{ Producto_ID: number }[]>`SELECT Producto_ID
          FROM productos
          WHERE Activo = 1 AND Stock_Actual <= Stock_Minimo
          ORDER BY Stock_Actual ASC`,

        // f) Inventario muerto: sin ventas en los últimos 30 días (con stock > 0)
        prisma.$queryRaw<
          {
            productoId: number;
            sku: string;
            nombre: string;
            stock: number | bigint;
            costo: string | number | null;
          }[]
        >`SELECT p.Producto_ID AS productoId,
                 p.SKU_Codigo AS sku, p.Nombre AS nombre,
                 p.Stock_Actual AS stock, p.Costo_Promedio AS costo
          FROM productos p
          WHERE p.Activo = 1 AND p.Stock_Actual > 0
            AND NOT EXISTS (
              SELECT 1 FROM detalle_facturas d
              INNER JOIN facturas f ON f.Factura_ID = d.Factura_ID
              WHERE d.Producto_ID = p.Producto_ID AND f.Fecha_Emision >= ${desde30}
                AND (f.Tipo_Documento IS NULL OR f.Tipo_Documento = 'FACTURA')
            )
          ORDER BY p.Stock_Actual DESC`,

        // g) Alertas de margen bajo (< 20%) y productos a pérdida (margen < 0)
        prisma.$queryRaw<
          {
            productoId: number;
            sku: string;
            nombre: string;
            precio: string | number | null;
            costo: string | number | null;
            margenPct: number | string | null;
          }[]
        >`SELECT p.Producto_ID AS productoId, p.SKU_Codigo AS sku, p.Nombre AS nombre,
                 p.Precio_Venta AS precio, p.Costo_Promedio AS costo,
                 ROUND((p.Precio_Venta - p.Costo_Promedio) / p.Precio_Venta * 100, 2) AS margenPct
          FROM productos p
          WHERE p.Activo = 1 AND p.Precio_Venta > 0 AND p.Costo_Promedio > 0
          HAVING margenPct < 20
          ORDER BY margenPct ASC`,

        // h) Rotación (últimos 30 días): unidades vendidas por producto
        prisma.$queryRaw<
          {
            productoId: number;
            nombre: string;
            stock: number | bigint;
            unidades: string | number | bigint | null;
          }[]
        >`SELECT p.Producto_ID AS productoId, p.Nombre AS nombre,
                 p.Stock_Actual AS stock, SUM(d.Cantidad) AS unidades
          FROM detalle_facturas d
          INNER JOIN facturas f ON f.Factura_ID = d.Factura_ID
          INNER JOIN productos p ON p.Producto_ID = d.Producto_ID
          WHERE f.Fecha_Emision >= ${desde30}
            AND (f.Tipo_Documento IS NULL OR f.Tipo_Documento = 'FACTURA')
          GROUP BY p.Producto_ID, p.Nombre, p.Stock_Actual
          ORDER BY unidades DESC`
      ]);

    // ── Comparativa vs. período ANTERIOR (misma duración) ────────────────────
    // Alimenta los deltas (%) de crecimiento/caída de las tarjetas de KPI.
    const duracionMs = Math.max(1, hasta.getTime() - desde.getTime());
    const prevHasta = new Date(desde.getTime() - 1);
    const prevDesde = new Date(desde.getTime() - duracionMs);
    const [agregadoPrevio, rendimientoRaw, topProductosRaw] = await Promise.all([
      prisma.facturas.aggregate({
        _sum: { Total_General: true },
        _count: { _all: true },
        where: {
          Fecha_Emision: { gte: prevDesde, lte: prevHasta },
          OR: [{ Tipo_Documento: null }, { Tipo_Documento: 'FACTURA' }],
        },
      }),

      // ── Rendimiento por cajero (BI Fase 3) ────────────────────────────────
      // LEFT JOIN seguro: si un usuario fue removido, la venta NO se pierde.
      prisma.$queryRaw<
        {
          usuarioId: number | null;
          nombre: string | null;
          rol: string | null;
          facturas: number | bigint;
          monto: string | number | null;
          montoBs: string | number | null;
        }[]
      >`SELECT u.Usuario_ID AS usuarioId, u.Nombre AS nombre, u.Rol AS rol,
               COUNT(f.Factura_ID) AS facturas,
               COALESCE(SUM(f.Total_General), 0) AS monto,
               COALESCE(SUM(f.Total_General * f.Tasa_Cambio), 0) AS montoBs
        FROM facturas f
        LEFT JOIN usuarios u ON u.Usuario_ID = f.Usuario_ID
        WHERE f.Fecha_Emision >= ${desde} AND f.Fecha_Emision <= ${hasta}
          AND (f.Tipo_Documento IS NULL OR f.Tipo_Documento = 'FACTURA')
        GROUP BY u.Usuario_ID, u.Nombre, u.Rol
        ORDER BY monto DESC`,

      // Top 10 productos más vendidos del periodo.
      prisma.$queryRaw<
        {
          productoId: number;
          nombre: string;
          unidades: string | number | bigint;
          monto: string | number | null;
          imagenUrl: string | null;
          marca: string | null;
          categoria: string | null;
        }[]
      >`SELECT p.Producto_ID AS productoId,
               p.Nombre AS nombre,
               SUM(d.Cantidad) AS unidades,
               SUM(d.Subtotal) AS monto,
               p.Imagen_URL AS imagenUrl,
               p.Marca AS marca,
               c.Nombre AS categoria
        FROM detalle_facturas d
        INNER JOIN facturas f ON f.Factura_ID = d.Factura_ID
        INNER JOIN productos p ON p.Producto_ID = d.Producto_ID
        LEFT JOIN categorias c ON c.Categoria_ID = p.Categoria_ID
        WHERE f.Fecha_Emision >= ${desde} AND f.Fecha_Emision <= ${hasta}
          AND (f.Tipo_Documento IS NULL OR f.Tipo_Documento = 'FACTURA')
        GROUP BY p.Producto_ID, p.Nombre, p.Imagen_URL, p.Marca, c.Nombre
        ORDER BY unidades DESC
        LIMIT 10`
    ]);

    const totalCajeros = rendimientoRaw.reduce((t, r) => t + n(r.monto), 0);
    // Se añade `ticketPromedio` (monto / facturas) para responder "quién vende
    // mejor por ticket", no solo "quién factura más".
    const rendimientoCajeros = rendimientoRaw.map((r) => {
      const facturas = Number(r.facturas);
      const monto = n(r.monto);
      return {
        usuarioId: r.usuarioId != null ? Number(r.usuarioId) : null,
        nombre: r.nombre ?? 'Usuario eliminado',
        rol: r.rol ?? '—',
        facturas,
        monto,
        montoBs: n(r.montoBs),
        ticketPromedio: facturas > 0 ? Number((monto / facturas).toFixed(2)) : 0,
        ticketPromedioBs: facturas > 0 ? Number((n(r.montoBs) / facturas).toFixed(2)) : 0,
        porcentaje:
          totalCajeros > 0
            ? Number(((monto / totalCajeros) * 100).toFixed(1))
            : 0,
      };
    });

    const alertasStock = productosBajoStock
      .map((p) => ({
        Producto_ID: Number(p.Producto_ID),
        SKU_Codigo: p.SKU_Codigo,
        Nombre: p.Nombre,
        Stock_Actual: Number(p.Stock_Actual),
        Stock_Minimo: Number(p.Stock_Minimo),
      }))
      .sort((a, b) => a.Stock_Actual - b.Stock_Actual);

    const resumenVentasRow = resumenVentas[0];
    const montoTotal = n(resumenVentasRow?.monto);
    const montoTotalBs = n(resumenVentasRow?.montoBs);
    const cantidadFacturas = n(resumenVentasRow?.facturas);
    const ticketPromedio = cantidadFacturas > 0 ? montoTotal / cantidadFacturas : 0;
    const ticketPromedioBs = cantidadFacturas > 0 ? montoTotalBs / cantidadFacturas : 0;

    // Deltas % vs período anterior (null cuando no hay base de comparación →
    // la UI muestra "sin datos previos" en vez de un 0% engañoso).
    const montoPrevio = n((agregadoPrevio._sum as any)?.Total_General);
    const facturasPrevias = n((agregadoPrevio as any)?._count?._all);
    const ticketPrevio = facturasPrevias > 0 ? montoPrevio / facturasPrevias : 0;
    const deltaPct = (actual: number, previo: number): number | null =>
      previo > 0 ? Number((((actual - previo) / previo) * 100).toFixed(1)) : null;

    // ── Asistente de Negocio ─────────────────────────────────────────────────
    // Inventario muerto (con stock > 0 pero sin ventas en 30 días), valorizado.
    const inventarioMuerto = (inventarioMuertoRaw as any[]).map((p) => ({
      productoId: Number(p.productoId),
      sku: p.sku,
      nombre: p.nombre,
      stock: n(p.stock),
      costoDolar: n(p.costo),
      valorDolares: Number((n(p.stock) * n(p.costo)).toFixed(2))
    }));

    // Alertas de margen: <0 → pérdida; 0-20 → margen bajo.
    const alertasMargen = (alertasMargenRaw as any[]).map((p) => {
      const margenPct = Number(p.margenPct);
      return {
        productoId: Number(p.productoId),
        sku: p.sku,
        nombre: p.nombre,
        precioDolar: n(p.precio),
        costoDolar: n(p.costo),
        margenPct,
        posicion: margenPct < 0 ? 'perdida' : 'bajo'
      };
    });

    // Índice de rotación = unidades vendidas (30d) / stock actual.
    const rotacion = (rotacionRaw as any[]).map((r) => {
      const stock = n(r.stock);
      const unidades = n(r.unidades);
      return {
        productoId: Number(r.productoId),
        nombre: r.nombre,
        unidades,
        stock,
        indice: stock > 0 ? Number((unidades / stock).toFixed(2)) : unidades
      };
    });
    const mayorRotacion = [...rotacion]
      .sort((a, b) => b.indice - a.indice)
      .slice(0, 3);
    const menorRotacion = [...rotacion]
      .sort((a, b) => a.indice - b.indice)
      .slice(0, 3);

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
      // Deltas para las tarjetas de KPI (verde si crece, rojo si cae).
      comparativa: {
        ventasPrevias: montoPrevio,
        facturasPrevias,
        ticketPrevio,
        deltaVentasPct: deltaPct(montoTotal, montoPrevio),
        deltaFacturasPct: deltaPct(cantidadFacturas, facturasPrevias),
        deltaTicketPct: deltaPct(ticketPromedio, ticketPrevio)
      },
      // Ranking de cajeros del período (BI Fase 3): monto, facturas y % del total.
      rendimientoCajeros,
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
      conteoAlertasStock: idsBajoStockRaw.length,
      idsBajoStock: idsBajoStockRaw.map((p) => Number(p.Producto_ID)),
      topProductos: topProductosRaw.map((t) => ({
        productoId: Number(t.productoId),
        nombre: t.nombre,
        unidades: n(t.unidades),
        monto: n(t.monto),
        // Ruta relativa servida por el backend (/productos/{sku}.webp).
        imagenUrl: t.imagenUrl ?? null,
        marca: t.marca ?? null,
        categoria: t.categoria ?? null
      })),
      // Nodo del Asistente de Negocio (analítica de 30 días).
      asistente: {
        inventarioMuerto,
        alertasMargen,
        rotacion: { mayorRotacion, menorRotacion }
      }
    });
  } catch (error) {
    console.error('Error al generar la serie financiera del dashboard:', error);
    return responderErrorPrisma(res, error, {
      recurso: 'dashboard',
      contexto: 'obtener la serie financiera del',
    });
  }
};

export const getDashboardMetrics = async (_req: Request, res: Response) => {
  try {
    const [
      totalProductos,
      conteoStockBajo,
      totalClientes,
      totalProveedores,
      resumenVentas,
      resumenEntradas,
      ventasBsRaw
    ] = await Promise.all([
      // 1. Total de productos activos
      prisma.productos.count({ where: { Activo: true } }),

      // 2. Solo se necesita el conteo para el badge del Dashboard.
      // No se cargan miles de objetos de producto al frontend.
      prisma.$queryRaw<{ total: number | bigint }[]>`SELECT COUNT(*) AS total
        FROM productos
        WHERE Activo = 1 AND Stock_Actual <= Stock_Minimo`,

      // 3. Totales de clientes y proveedores
      prisma.clientes.count(),
      prisma.proveedores.count(),

      // 4. Suma total y conteo de facturas (Ventas en USD). Solo FACTURA:
      // se excluyen NOTA_CREDITO para no contaminar el total global.
      prisma.facturas.aggregate({
        _sum: { Total_General: true },
        _count: { _all: true },
        where: { OR: [{ Tipo_Documento: null }, { Tipo_Documento: 'FACTURA' }] }
      }),

      // 5. Suma total y conteo de notas de entrega (Compras)
      prisma.notas_entrega_entrada.aggregate({
        _sum: { Total_Costo: true },
        _count: { _all: true }
      }),

      // 6. Ventas reales en Bs = Σ (Total_General × tasa_bcv_historica), solo FACTURA
      prisma.$queryRaw<{ montoBs: string | number | null }[]>`SELECT COALESCE(SUM(Total_General * Tasa_Cambio), 0) AS montoBs FROM facturas WHERE Tipo_Documento IS NULL OR Tipo_Documento = 'FACTURA'`
    ]);

    const stockBajo = Number(conteoStockBajo[0]?.total ?? 0);

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
        conteoStockBajo: stockBajo
      }
    });
  } catch (error) {
    console.error('Error al generar métricas del dashboard:', error);
    return responderErrorPrisma(res, error, {
      recurso: 'dashboard',
      contexto: 'obtener las metricas del',
    });
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

  // Formato numérico venezolano: separador decimal ',' y de miles '.'.
  const fmtVes = (x: number): string => {
    const neg = x < 0;
    const fixed = Math.abs(x).toFixed(2);
    const [ent, dec] = fixed.split('.');
    const agrupado = ent.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return (neg ? '-' : '') + agrupado + ',' + dec;
  };
  const fmtFecha = (d: Date): string =>
    `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  // CSV localizado: ';' como delimitador (la ',' es decimal). Se entrecomilla
  // solo si el valor contiene ';' (delimitador), comillas o saltos de línea,
  // para que Excel interprete fechas y números de forma nativa.
  const esc = (v: unknown): string => {
    const s = v?.toString() ?? '';
    // Solo ';' (delimitador), comillas o saltos de línea fuerzan entrecomillado.
    // La ',' es decimal y la '/' es parte de fechas: no se entrecomillan, para
    // que Excel interprete fechas y números de forma nativa.
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };


  try {
    const tienda = await prisma.configuracion_tienda.findFirst();
    const facturas = await prisma.facturas.findMany({
      where: { Fecha_Emision: { gte: desde, lte: hasta } },
      include: {
        clientes: { select: { Razon_Social: true, RIF_Cedula: true } },
        pagos: { select: { Metodo_Pago: true, Monto: true, Es_Divisa: true } },
        // Cajero: usuario que emitió la factura.
        usuarios: { select: { Nombre: true, Rol: true } }
      },
      orderBy: { Fecha_Emision: 'asc' }
    });

    const filas = facturas.map((f) => {
      const tasa = n(f.Tasa_Cambio) || 0;
      const subtotalUsd = n(f.Subtotal);
      const ivaUsd = n(f.Total_IVA);
      const totalUsd = n(f.Total_General);
      const metodos = [...new Set(f.pagos.map((p) => p.Metodo_Pago))]
        .filter(Boolean)
        .join(' | ');
      return {
        fecha: fmtFecha(f.Fecha_Emision),
        nFactura: f.Numero_Control ?? '',
        cajero: (f.usuarios?.Nombre ?? '').toString().trim() || '—',
        metodoPago: metodos,
        // Subtotal/IVA/Total en Bs (VES); Ref USD en dólares de referencia.
        subtotalVes: subtotalUsd * tasa,
        ivaVes: ivaUsd * tasa,
        totalVes: totalUsd * tasa,
        refUsd: totalUsd
      };
    });

    if (formato === 'json') {
      return res.json({
        generado: new Date().toISOString(),
        periodo,
        razonSocial: tienda?.Nombre ?? null,
        rif: tienda?.RIF ?? null,
        totalRegistros: filas.length,
        registros: filas
      });
    }

    // Delimitador localizado.
    const DELIM = ';';
    const sumSub = filas.reduce((a, r) => a + r.subtotalVes, 0);
    const sumIva = filas.reduce((a, r) => a + r.ivaVes, 0);
    const sumTot = filas.reduce((a, r) => a + r.totalVes, 0);
    const sumRef = filas.reduce((a, r) => a + r.refUsd, 0);

    const lineas: string[] = [
      // Bloque de encabezado (razón social / RIF / período).
      ['Razón Social', tienda?.Nombre ?? 'Ferretería Adrialga C.A.'].map(esc).join(DELIM),
      ['RIF', tienda?.RIF ?? ''].map(esc).join(DELIM),
      ['Período Reportado', `${fmtFecha(desde)} al ${fmtFecha(hasta)}`].map(esc).join(DELIM),
      '', // separador
      // Encabezado de columnas.
      ['Fecha', 'N° Factura', 'Cajero', 'Método de Pago', 'Subtotal', 'IVA', 'Total VES', 'Ref USD'].join(DELIM)
    ];
    for (const f of filas) {
      lineas.push(
        [
          f.fecha, f.nFactura, f.cajero, f.metodoPago,
          fmtVes(f.subtotalVes), fmtVes(f.ivaVes), fmtVes(f.totalVes), fmtVes(f.refUsd)
        ].map(esc).join(DELIM)
      );
    }
    // Fila de totales al pie.
    lineas.push(
      ['TOTALES', '', '', '', fmtVes(sumSub), fmtVes(sumIva), fmtVes(sumTot), fmtVes(sumRef)]
        .map(esc).join(DELIM)
    );
    // CRLF (RFC-4180): mismo terminador de línea que el CSV fiscal de SENIAT
    // (seniat.controllers.ts). Excel en Windows lo interpreta de forma nativa y
    // evita que todas las filas queden en una sola celda.
    const csv = lineas.join('\r\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="libro_diario_${periodo}.csv"`
    );
    return res.send('\ufeff' + csv); // BOM UTF-8 para Excel (acentos/ñ)
  } catch (error) {
    console.error('Error al exportar el libro diario:', error);
    return responderErrorPrisma(res, error, {
      recurso: 'dashboard',
      contexto: 'exportar el libro diario del',
    });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// Centro de Notificaciones (Asistente de Negocio · Fase C)
// Solo lectura: no altera contabilidad, caja ni inventario.
// ─────────────────────────────────────────────────────────────────────────────

type Insight = {
  id: string;
  severidad: 'critico' | 'atencion' | 'positivo';
  modulo: 'caja' | 'inventario' | 'finanzas' | 'ventas';
  titulo: string;
  mensaje: string;
  datos?: Record<string, unknown>;
};

type TurnoConMovimientos = {
  Saldo_Inicial: unknown;
  movimientos: {
    Tipo: string;
    Monto_USD: unknown;
    Concepto: string | null;
    Metodo_Pago: string;
  }[];
};

/**
 * Replica EXACTAMENTE las reglas del reporte de arqueos (`getHistoricoArqueos`)
 * para no inventar una contabilidad paralela:
 *  - El INGRESO "Apertura de caja" NO se suma (ya vive en Saldo_Inicial).
 *  - Solo el EFECTIVO mueve la gaveta (los cobros digitales van al banco).
 *  - El EGRESO "Cierre de caja..." es el efectivo entregado, no un gasto.
 * Devuelve esperado, entregado, diferencia y estado (MATCH/SURPLUS/DEFICIT).
 */
const resumenArqueo = (t: TurnoConMovimientos) => {
  let ingresosD4 = 0n;
  let egresosOpD4 = 0n;
  let entregadoD4 = 0n;
  for (const m of t.movimientos) {
    const montoD4 = toD4(m.Monto_USD);
    const concepto = (m.Concepto ?? '').trim();
    if (m.Tipo === 'INGRESO') {
      if (concepto.startsWith('Apertura de caja')) continue;
      if (!esEfectivo(m.Metodo_Pago)) continue;
      ingresosD4 = addD4(ingresosD4, montoD4);
    } else if (m.Tipo === 'EGRESO') {
      if (concepto.startsWith('Cierre de caja')) {
        entregadoD4 = addD4(entregadoD4, montoD4);
      } else if (esEfectivo(m.Metodo_Pago)) {
        egresosOpD4 = addD4(egresosOpD4, montoD4);
      }
    }
  }
  const esperadoD4 = subD4(addD4(toD4(t.Saldo_Inicial), ingresosD4), egresosOpD4);
  const esperado = Number(aDecimal(esperadoD4));
  const entregado = Number(aDecimal(entregadoD4));
  const diferencia = Number(aDecimal(subD4(esperadoD4, entregadoD4)));
  return {
    esperado,
    entregado,
    diferencia,
    estado: evaluarArqueo(esperado, entregado, 0.01).estado,
  };
};

/**
 * GET /api/dashboard/notificaciones
 *
 * Insights del Asistente de Negocio clasificados por severidad para la campana
 * del AppBar: caja olvidada abierta, stock crítico, descuadres de arqueo y
 * señales positivas de ventas. Ordenados crítico → atención → positivo.
 */
export const getNotificaciones = async (_req: Request, res: Response) => {
  const ahora = Date.now();
  if (notificacionesCache && notificacionesCache.expiresAt > ahora) {
    return res.json({
      generado: new Date().toISOString(),
      ...notificacionesCache.payload,
    });
  }

  try {
    const hoy = calcularRango('hoy');
    const duracion = Math.max(1, hoy.hasta.getTime() - hoy.desde.getTime());
    const ayerHasta = new Date(hoy.desde.getTime() - 1);
    const ayerDesde = new Date(hoy.desde.getTime() - duracion - 1);
    const hace14 = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

    const [cajasAbiertas, criticos, turnosCerrados, ventasHoy, ventasAyer] =
      await Promise.all([
        prisma.caja.findMany({
          where: { Estado: 'ABIERTA' },
          include: { usuarios: { select: { Nombre: true } } },
          orderBy: { Fecha_Apertura: 'asc' },
        }),

        // Stock crítico REAL: comparación columna vs columna (no soportada por
        // el `where` de Prisma → $queryRaw). Se excluyen los ítems de catálogo
        // que NUNCA se han movido (ni ventas ni entradas): son "pendientes de
        // stock", no "agotados". Sin esto, los 7.211 productos del catálogo EPA
        // (importados con stock 0) saturarían el centro de notificaciones.
        prisma.$queryRaw<
          {
            productoId: number;
            sku: string;
            nombre: string;
            stock: number | bigint;
            minimo: number | bigint;
            imagenUrl: string | null;
          }[]
        >`SELECT p.Producto_ID AS productoId,
                 p.SKU_Codigo AS sku, p.Nombre AS nombre,
                 p.Stock_Actual AS stock, p.Stock_Minimo AS minimo,
                 p.Imagen_URL AS imagenUrl
          FROM productos p
          WHERE p.Activo = 1 AND p.Stock_Actual <= p.Stock_Minimo
            AND (EXISTS (SELECT 1 FROM detalle_facturas d WHERE d.Producto_ID = p.Producto_ID)
                 OR EXISTS (SELECT 1 FROM detalle_notas_entrega dn WHERE dn.Producto_ID = p.Producto_ID))
          ORDER BY p.Stock_Actual ASC
          LIMIT 50`,

        // Arqueos cerrados: no necesitamos transferir todos los movimientos
        // de hasta 30 turnos al proceso Node. Agregamos en MySQL únicamente
        // las cuatro magnitudes necesarias para el arqueo.
        prisma.$queryRaw<{
          Caja_ID: number;
          Saldo_Inicial: string | number;
          entregado: string | number;
          ingresos: string | number;
          egresos: string | number;
        }[]>(Prisma.sql`
          SELECT c.Caja_ID,
                 c.Saldo_Inicial,
                 COALESCE(SUM(CASE
                   WHEN m.Tipo = 'EGRESO'
                    AND BINARY LEFT(TRIM(m.Concepto), 14) = 'Cierre de caja'
                   THEN m.Monto_USD ELSE 0 END), 0) AS entregado,
                 COALESCE(SUM(CASE
                   WHEN m.Tipo = 'INGRESO'
                    AND BINARY LEFT(TRIM(m.Concepto), 17) = 'Apertura de caja'
                   THEN 0
                   WHEN m.Tipo = 'INGRESO'
                    AND LOWER(COALESCE(m.Metodo_Pago, '')) LIKE '%efectivo%'
                   THEN m.Monto_USD ELSE 0 END), 0) AS ingresos,
                 COALESCE(SUM(CASE
                   WHEN m.Tipo = 'EGRESO'
                    AND BINARY LEFT(TRIM(m.Concepto), 14) = 'Cierre de caja'
                   THEN 0
                   WHEN m.Tipo = 'EGRESO'
                    AND LOWER(COALESCE(m.Metodo_Pago, '')) LIKE '%efectivo%'
                   THEN m.Monto_USD ELSE 0 END), 0) AS egresos
          FROM caja c
          LEFT JOIN movimientos_caja m ON m.Caja_ID = c.Caja_ID
          WHERE c.Estado = 'CERRADA'
            AND c.Fecha_Cierre >= ${hace14}
          GROUP BY c.Caja_ID, c.Saldo_Inicial
          ORDER BY MAX(c.Fecha_Cierre) DESC
          LIMIT 30
        `),

        prisma.facturas.aggregate({
          _sum: { Total_General: true },
          where: { Fecha_Emision: { gte: hoy.desde, lte: hoy.hasta } },
        }),
        prisma.facturas.aggregate({
          _sum: { Total_General: true },
          where: { Fecha_Emision: { gte: ayerDesde, lte: ayerHasta } },
        }),
      ]);

    const insights: Insight[] = [];

    // 1) Caja olvidada abierta (abierta en un día anterior al de hoy)
    for (const c of cajasAbiertas) {
      const olvidada = c.Fecha_Apertura < hoy.desde;
      insights.push({
        id: `caja-abierta-${c.Caja_ID}`,
        severidad: olvidada ? 'critico' : 'atencion',
        modulo: 'caja',
        titulo: olvidada ? 'Caja olvidada abierta' : 'Turno de caja abierto',
        mensaje: olvidada
          ? `La caja "${c.Nombre}" sigue ABIERTA desde el ${c.Fecha_Apertura
              .toISOString()
              .slice(0, 10)}. Realice el cierre y el arqueo.`
          : `La caja "${c.Nombre}" está abierta (${c.usuarios?.Nombre ?? 'usuario no disponible'}). Recuerde hacer el arqueo al finalizar.`,
        datos: {
          cajaId: c.Caja_ID,
          apertura: c.Fecha_Apertura.toISOString(),
          saldoActual: Number(c.Saldo_Actual?.toString() ?? 0),
        },
      });
    }

    // 2) Stock crítico
    const agotados = criticos.filter((p) => n(p.stock) <= 0);
    const bajos = criticos.filter((p) => n(p.stock) > 0);
    if (agotados.length) {
      insights.push({
        id: 'stock-agotado',
        severidad: 'critico',
        modulo: 'inventario',
        titulo: 'Productos agotados',
        mensaje:
          `${agotados.length} producto(s) con existencias en 0 que sí han tenido movimiento.`,
        datos: { total: agotados.length, productos: agotados.slice(0, 5) },
      });
    }
    if (bajos.length) {
      insights.push({
        id: 'stock-bajo',
        severidad: 'atencion',
        modulo: 'inventario',
        titulo: 'Stock por debajo del mínimo',
        mensaje:
          `${bajos.length} producto(s) están en o por debajo de su stock mínimo. Programe la reposición.`,
        datos: { total: bajos.length, productos: bajos.slice(0, 5) },
      });
    }

    // 3) Descuadres de arqueo (turnos cerrados de los últimos 14 días).
    // Los movimientos ya vienen agregados desde MySQL; mantenemos aquí
    // exactamente la aritmética D4 usada por resumenArqueo().
    for (const t of turnosCerrados) {
      const ingresosD4 = toD4(t.ingresos);
      const egresosD4 = toD4(t.egresos);
      const entregadoD4 = toD4(t.entregado);
      const esperadoD4 = subD4(addD4(toD4(t.Saldo_Inicial), ingresosD4), egresosD4);
      const esperado = Number(aDecimal(esperadoD4));
      const entregado = Number(aDecimal(entregadoD4));
      const diferencia = Number(aDecimal(subD4(esperadoD4, entregadoD4)));
      const estado = evaluarArqueo(esperado, entregado, 0.01).estado;
      if (estado === 'MATCH') continue;
      insights.push({
        id: `arqueo-${t.Caja_ID}`,
        severidad: estado === 'DEFICIT' ? 'critico' : 'atencion',
        modulo: 'finanzas',
        titulo: estado === 'DEFICIT' ? 'Faltante en arqueo' : 'Sobrante en arqueo',
        mensaje:
          `Turno #${t.Caja_ID}: esperado $${esperado.toFixed(2)} vs entregado ` +
          `$${entregado.toFixed(2)} — ${diferencia > 0 ? 'faltan' : 'sobran'} ` +
          `$${Math.abs(diferencia).toFixed(2)}.`,
        datos: {
          turnoId: t.Caja_ID,
          esperado,
          entregado,
          diferencia,
          estado,
        },
      });
    }

    // 4) Señal positiva: ventas de hoy por encima de ayer
    const vHoy = n((ventasHoy._sum as any)?.Total_General);
    const vAyer = n((ventasAyer._sum as any)?.Total_General);
    if (vAyer > 0 && vHoy > vAyer) {
      const pct = ((vHoy - vAyer) / vAyer) * 100;
      insights.push({
        id: 'ventas-al-alza',
        severidad: 'positivo',
        modulo: 'ventas',
        titulo: 'Ventas por encima de ayer',
        mensaje:
          `Hoy $${vHoy.toFixed(2)} frente a $${vAyer.toFixed(2)} de ayer (+${pct.toFixed(1)}%).`,
        datos: { hoy: vHoy, ayer: vAyer, deltaPct: Number(pct.toFixed(1)) },
      });
    }

    // Orden estable: crítico → atención → positivo
    const peso: Record<Insight['severidad'], number> = {
      critico: 0,
      atencion: 1,
      positivo: 2,
    };
    insights.sort((a, b) => peso[a.severidad] - peso[b.severidad]);

    const payload: NotificacionesPayload = {
      total: insights.length,
      conteo: {
        critico: insights.filter((i) => i.severidad === 'critico').length,
        atencion: insights.filter((i) => i.severidad === 'atencion').length,
        positivo: insights.filter((i) => i.severidad === 'positivo').length,
      },
      insights,
    };

    notificacionesCache = {
      expiresAt: Date.now() + NOTIFICACIONES_CACHE_MS,
      payload,
    };

    res.json({
      generado: new Date().toISOString(),
      ...payload,
    });
  } catch (error) {
    console.error('Error al generar las notificaciones del dashboard:', error);
    return responderErrorPrisma(res, error, {
      recurso: 'dashboard',
      contexto: 'obtener las notificaciones del',
    });
  }
};