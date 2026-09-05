// adrialga-backend/src/controllers/scraping.controllers.ts
import { Response } from 'express';
import { AuthRequest } from '../middlewares/auth.middleware';
import { prisma } from '../config/db';
import { ScrapingService } from '../services/scraping.service';

/**
 * GET /api/scraping/bcv
 * Devuelve la tasa de cambio actual del BCV vía el microservicio Python.
 */
export async function getTasaBCV(_req: AuthRequest, res: Response) {
  try {
    const tasa = await ScrapingService.obtenerTasaBCV();
    return res.json(tasa);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error desconocido';
    // 502: el fallo está en el servicio aguas arriba, no en este backend
    return res.status(502).json({ message });
  }
}

/**
 * POST /api/scraping/sincronizar-precios
 * Body opcional: { objetivos?: string[] } (SKUs o URLs de productos).
 *
 * Flujo:
 *  1. Obtiene la tasa BCV actual (factor de conversión Bs/USD).
 *  2. Ejecuta el scraping de proveedores en el microservicio Python.
 *  3. En una transacción Prisma, actualiza Costo_Promedio (USD) de cada
 *     producto local cuyo SKU_Codigo coincida con item.sku_proveedor.
 *     Nota: el esquema NO tiene columna de precio en moneda local; todos los
 *     montos del sistema están denominados en USD y se convierten a Bs en
 *     el punto de cobro con la Tasa_Cambio histórica de cada factura.
 *     El precio de venta (Precio_Venta) NO se toca: la decisión de margen
 *     sigue siendo manual del encargado.
 *  4. Los SKUs que el scraper trajo pero que no existen en el inventario se
 *     reportan en no_encontrados_db.
 */
export async function sincronizarPrecios(req: AuthRequest, res: Response) {
  const objetivos = Array.isArray(req.body?.objetivos)
    ? (req.body.objetivos as string[]).filter(
        (o) => typeof o === 'string' && o.trim().length > 0
      )
    : undefined;

  try {
    // 1) Tasa BCV actual (factor Bs/USD para referencia del frontend)
    const tasa = await ScrapingService.obtenerTasaBCV();
    const tasaBcv = tasa.tasa;

    // 2) Scraping de proveedores (respuesta validada con Zod)
    const respuesta = await ScrapingService.ejecutarScrapingProveedores(
      objetivos && objetivos.length > 0 ? objetivos : undefined
    );

    // 3) Persistencia atómica en MySQL
    const noEncontradosDb: string[] = [];
    let actualizadosDb = 0;

    if (respuesta.items.length > 0) {
      await prisma.$transaction(async (tx) => {
        for (const item of respuesta.items) {
          const producto = await tx.productos.findUnique({
            where: { SKU_Codigo: item.sku_proveedor },
            select: { Producto_ID: true },
          });

          if (!producto) {
            noEncontradosDb.push(item.sku_proveedor);
            continue;
          }

          await tx.productos.update({
            where: { Producto_ID: producto.Producto_ID },
            data: {
              // Precio de proveedor (USD) → costo promedio del inventario
              Costo_Promedio: item.precio_usd,
            },
          });
          actualizadosDb += 1;
        }
      });
    }

    // 4) Resumen ampliado para el frontend
    return res.json({
      message: 'Sincronización de precios completada',
      resumen: {
        status: respuesta.status,
        ejecutado_en: respuesta.ejecutado_en,
        // Resultado del scraping
        total_items_scraping: respuesta.total_items,
        actualizados_scraping: respuesta.actualizados,
        errores_scraping: respuesta.errores,
        // Resultado de la persistencia en BD
        actualizados_db: actualizadosDb,
        no_encontrados_db: noEncontradosDb,
        // Conversión usada
        tasa_bcv_aplicada: tasaBcv,
      },
      items: respuesta.items,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Error desconocido';
    return res.status(502).json({ message });
  }
}
