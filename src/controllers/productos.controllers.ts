import { Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { siguienteSkuPorCategoria } from '../utils/sku';
import { responderErrorPrisma } from '../utils/errores';

/**
 * Motor precio/margen (Fase 2): tipo de resolución forzado en servidor para
 * preservar la integridad financiera sin depender del cliente.
 *   - Si llegan costo + margen  → precio = costo * (1 + margen/100).
 *   - Si llega precio + costo    → margen = (precio/costo − 1) * 100.
 *   - Si solo llega precio       → se conservan margen/costo previos.
 * Los campos que no se recalculan se devuelven undefined (no sobreescribir).
 */
function resolverPrecioYMargen(opts: {
  precio?: unknown;
  costo?: unknown;
  margen?: unknown;
  precioActual?: number;
  costoActual?: number;
  margenActual?: number;
}): { Precio_Venta?: number; Costo_Ultimo?: number; Margen_Ganancia?: number } {
  const num = (v: unknown): number | undefined => {
    const n = typeof v === 'string' ? Number(v.replace(',', '.')) : Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const precio = num(opts.precio);
  const costo = num(opts.costo);
  const margen = num(opts.margen);
  const out: { Precio_Venta?: number; Costo_Ultimo?: number; Margen_Ganancia?: number } = {};

  if (costo !== undefined) out.Costo_Ultimo = costo;

  if (costo !== undefined && margen !== undefined) {
    out.Precio_Venta = Number((costo * (1 + margen / 100)).toFixed(6));
    out.Margen_Ganancia = margen;
  } else if (precio !== undefined && costo !== undefined && costo > 0) {
    out.Precio_Venta = precio;
    out.Margen_Ganancia = Number((((precio / costo) - 1) * 100).toFixed(6));
  } else if (precio !== undefined) {
    out.Precio_Venta = precio;
    // Conservamos el margen existente si llega por el payload; si no, no tocar.
    if (margen !== undefined) out.Margen_Ganancia = margen;
  }
  return out;
}

import { IoStore } from '../utils/socket';

/**
 * GET /api/productos?q=&categoriaId=&limit=&offset=
 *
 * Retrocompatible: SIN parámetros devuelve exactamente el mismo arreglo de
 * siempre. Con parámetros permite paginar/filtrar en servidor, imprescindible
 * desde que el catálogo EPA elevó el inventario a ~7.200 ítems (cargar todo
 * en el cliente colapsaba la tabla de Flutter).
 *
 * El total que coincide con el filtro viaja en la cabecera `X-Total-Count`
 * para que la UI pueda paginar sin una segunda petición de conteo.
 */
export const getProductos = async (req: Request, res: Response) => {
  try {
    // Solo productos activos: un ítem desactivado (soft-delete) no puede
    // ser vendido de nuevo desde ninguna terminal POS o compra.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const where: any = { Activo: true };

    const q = (req.query.q ?? '').toString().trim();
    if (q) {
      where.OR = [
        { Nombre: { contains: q } },
        { SKU_Codigo: { contains: q } },
        { Codigo_EPA: { contains: q } },
        { Marca: { contains: q } },
      ];
    }

    // `categoriaId` admite lista separada por comas (1,2,3) para filtrar por
    // un subárbol completo de categorías (padre + descendientes).
    const idsRaw = (req.query.ids ?? '').toString().trim();
    if (idsRaw) {
      const ids = idsRaw
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n > 0)
        .slice(0, 50);
      if (ids.length) where.Producto_ID = { in: ids };
    }

    const idsCat = (req.query.categoriaId ?? '').toString().trim();
    if (idsCat) {
      const ids = idsCat
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n > 0);
      if (ids.length) where.Categoria_ID = { in: ids };
    }

    // Filtro de existencias compartido por POS e Inventario.
    // `conStock` se conserva por compatibilidad; `sinStock` identifica
    // explícitamente agotados. Nunca se interpreta un error de carga como stock 0.
    const conStockRaw = (req.query.conStock ?? '').toString().trim().toLowerCase();
    const sinStockRaw = (req.query.sinStock ?? '').toString().trim().toLowerCase();
    const pideConStock = conStockRaw === '1' || conStockRaw === 'true';
    const pideSinStock = sinStockRaw === '1' || sinStockRaw === 'true';
    if (pideConStock && pideSinStock) {
      return res.status(400).json({
        code: 'FILTRO_STOCK_INVALIDO',
        message: 'Seleccione con existencia o sin existencia, no ambos.',
      });
    }
    if (pideConStock) where.Stock_Actual = { gt: 0 };
    if (pideSinStock) where.Stock_Actual = { lte: 0 };

    // Filtro por PROVEEDOR: el vínculo producto↔proveedor se deriva de las
    // notas de entrega (compras reales). Regla de procedencia del catálogo
    // demo: los ítems importados de EPA (Codigo_EPA presente) que aún no tienen
    // ninguna nota registrada también se atribuyen a FERRETERIA EPA (id 9).
    // `proveedorId=0` lista los productos sin proveedor atribuible.
    const provRaw = (req.query.proveedorId ?? '').toString().trim();
    if (provRaw !== '') {
      const provId = Number(provRaw);
      if (Number.isInteger(provId) && provId > 0) {
        const comprados = {
          detalle_notas_entrega: {
            some: { notas_entrega_entrada: { Proveedor_ID: provId } },
          },
        };
        where.AND = [
          ...(where.AND ?? []),
          provId === 9
            ? {
                OR: [
                  comprados,
                  { Codigo_EPA: { not: null }, detalle_notas_entrega: { none: {} } },
                ],
              }
            : comprados,
        ];
      } else if (provId === 0) {
        where.detalle_notas_entrega = { none: {} };
        where.Codigo_EPA = null;
      }
      // Valores no enteros se ignoran a propósito (no rompen el listado).
    }

    const limitRaw = Number(req.query.limit);
    const offsetRaw = Number(req.query.offset);
    const limit =
      Number.isInteger(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : null;
    const offset = Number.isInteger(offsetRaw) && offsetRaw > 0 ? offsetRaw : 0;

    const [productos, total] = await Promise.all([
      prisma.productos.findMany({
        where,
        include: { categorias: true },
        orderBy: { Producto_ID: 'desc' },
        ...(limit ? { take: limit, skip: offset } : {}),
      }),
      prisma.productos.count({ where }),
    ]);

    // Cabecera expuesta vía CORS (ver `exposedHeaders` en index.ts).
    res.setHeader('X-Total-Count', String(total));
    res.json(productos);
  } catch (error) {
    return responderErrorPrisma(res, error, {
      recurso: 'producto',
      contexto: 'obtener los',
    });
  }
};

export const getProductoById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const producto = await prisma.productos.findUnique({
      where: { Producto_ID: Number(id) },
      include: { categorias: true }
    });

    if (!producto) {
      return res.status(404).json({ message: 'Producto no encontrado' });
    }

    res.json(producto);
  } catch (error) {
    return responderErrorPrisma(res, error, {
      recurso: 'producto',
      contexto: 'obtener el',
    });
  }
};

export const createProducto = async (req: Request, res: Response) => {
  try {
    const {
      SKU_Codigo,
      Nombre,
      Precio_Venta,
      Costo_Promedio,
      Costo_Ultimo,
      Margen_Ganancia,
      Stock_Actual,
      Stock_Minimo,
      Categoria_ID
    } = req.body;

    if (!Nombre || !Categoria_ID) {
      return res.status(400).json({
        message: 'Nombre y Categoria_ID son obligatorios'
      });
    }

    // Recálculo servidoreside: si el cajero edita costo+margen, el precio se
    // deriva; si solo manda precio+costo, se deriva el margen.
    // El costo legado (Costo_Promedio) se trata como base si no hay Costo_Ultimo.
    const costoBase = Costo_Ultimo ?? Costo_Promedio;
    const precios = resolverPrecioYMargen({
      precio: Precio_Venta,
      costo: costoBase,
      margen: Margen_Ganancia,
    });
    const costoInicial = Number(costoBase) || 0;

    const nuevoProducto = await prisma.$transaction(async (tx) => {
      // Si el cliente no envía SKU, se genera automáticamente por categoría
      const skuFinal = SKU_Codigo && String(SKU_Codigo).trim() !== ''
        ? String(SKU_Codigo).trim()
        : await siguienteSkuPorCategoria(tx, Number(Categoria_ID));

      if (!skuFinal) {
        throw new Error('CATEGORIA_NO_ENCONTRADA');
      }

      return tx.productos.create({
        data: {
          SKU_Codigo: skuFinal,
          Nombre,
          Precio_Venta: precios.Precio_Venta ?? (Number(Precio_Venta) || 0),
          Costo_Promedio: Number(Costo_Promedio) || costoInicial,
          Costo_Ultimo: precios.Costo_Ultimo ?? costoInicial,
          Margen_Ganancia: precios.Margen_Ganancia ?? 0,
          Stock_Actual: Number(Stock_Actual) || 0,
          Stock_Minimo: Number(Stock_Minimo) || 5,
          // Enlace de imagen: ruta local (/productos/sku.webp) o URL externa
          // (http/https). Antes el formulario lo enviaba y el backend lo
          // descartaba en silencio.
          Imagen_URL:
            typeof req.body.Imagen_URL === 'string' &&
            req.body.Imagen_URL.trim() !== ''
              ? req.body.Imagen_URL.trim()
              : null,
          Categoria_ID: Number(Categoria_ID)
        },
        include: { categorias: true }
      });
    });

    IoStore.emitDbUpdate(
      'inventario',
      `Nuevo producto: ${nuevoProducto.Nombre} (SKU ${nuevoProducto.SKU_Codigo})`,
      { productoId: nuevoProducto.Producto_ID },
    );
    res.status(201).json(nuevoProducto);
  } catch (error) {
    if (error instanceof Error && error.message === 'CATEGORIA_NO_ENCONTRADA') {
      return res.status(404).json({ message: 'La categoría indicada no existe' });
    }
    // Colisión por SKU duplicado (restricción @unique)
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return res.status(409).json({
        success: false,
        code: 'DUPLICADO',
        message: 'El código SKU ya existe. Refresque la sugerencia o ingrese uno diferente.',
        error: 'El código SKU ya existe. Refresque la sugerencia o ingrese uno diferente.',
      });
    }
    // FASE 3: el resto se mapea con el contrato uniforme.
    return responderErrorPrisma(res, error, {
      recurso: 'producto',
      contexto: 'registrar el',
    });
  }
};

export const updateProducto = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const {
      SKU_Codigo,
      Nombre,
      Precio_Venta,
      Costo_Promedio,
      Costo_Ultimo,
      Margen_Ganancia,
      Stock_Actual,
      Stock_Minimo,
      Categoria_ID
    } = req.body;

    // Recálculo servidoreside (cualquier cliente puede mandar campos
    // combinados): costo+margen → precio; precio+costo → margen.
    const precios = resolverPrecioYMargen({
      precio: Precio_Venta,
      costo: Costo_Ultimo,
      margen: Margen_Ganancia,
    });

    const productoActualizado = await prisma.$transaction(async (tx) => {
      // Ajustes administrativos de stock también deben serializarse frente a
      // ventas, entradas y reversas: primero se bloquea la fila y luego se
      // aplica el valor solicitado dentro de la misma transacción.
      await tx.$queryRaw(Prisma.sql`
        SELECT Producto_ID
        FROM productos
        WHERE Producto_ID = ${Number(id)}
        FOR UPDATE
      `);

      return tx.productos.update({
      where: { Producto_ID: Number(id) },
      data: {
        SKU_Codigo,
        Nombre,
        Precio_Venta: precios.Precio_Venta,
        Costo_Promedio: Costo_Promedio !== undefined ? Number(Costo_Promedio) : undefined,
        Costo_Ultimo: precios.Costo_Ultimo,
        Margen_Ganancia: precios.Margen_Ganancia,
        Stock_Actual: Stock_Actual !== undefined ? Number(Stock_Actual) : undefined,
        Stock_Minimo: Stock_Minimo !== undefined ? Number(Stock_Minimo) : undefined,
        // Igual que en create: cadena vacía limpia la imagen; undefined la
        // deja intacta. Cualquier URL http(s) es válida.
        Imagen_URL:
          typeof req.body.Imagen_URL === 'string'
            ? (req.body.Imagen_URL.trim() === ''
                ? null
                : req.body.Imagen_URL.trim())
            : undefined,
        Categoria_ID: Categoria_ID !== undefined ? Number(Categoria_ID) : undefined
      },
      include: { categorias: true }
      });
    });

    IoStore.emitDbUpdate('inventario', `Producto actualizado: ${productoActualizado.Nombre}`, { productoId: productoActualizado.Producto_ID });
    res.json(productoActualizado);
  } catch (error) {
    // FASE 3: P2025 (producto inexistente) -> 404; P2002 (SKU duplicado) -> 409;
    // P2003 (categoria inexistente) -> 400. Antes todo era 500.
    return responderErrorPrisma(res, error, {
      recurso: 'producto',
      contexto: 'actualizar el',
    });
  }
};

/**
 * GET /api/productos/:id/variantes
 *
 * Matriz de variantes del producto: para cada fila devuelve los atributos
 * como pares clave/valor y los ejes de la matriz (atributos únicos con sus
 * valores posibles), listo para renderizar una cuadrícula en la UI o el
 * acordeón móvil.
 */
export const getVariantesDeProducto = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ message: 'ID de producto inválido' });
    }
    const producto = await prisma.productos.findUnique({
      where: { Producto_ID: id },
      include: {
        categorias: { select: { Margen_Sugerido: true } },
        producto_variantes: {
          where: { Activo: true },
          include: { atributos: true },
          orderBy: { Variante_ID: 'asc' },
        },
      },
    });
    if (!producto) {
      return res.status(404).json({ message: 'Producto no encontrado' });
    }

    // Cascada de margen: Variante → Producto → Categoría → 0.
    const margenPadre = Number(producto.Margen_Ganancia);
    const margenCat = producto.categorias?.Margen_Sugerido != null
      ? Number(producto.categorias.Margen_Sugerido)
      : 0;
    const margenBase = margenPadre > 0 ? margenPadre : margenCat;

    // Ejes de la matriz: { Atributo → [valores únicos] }.
    const ejes: Record<string, string[]> = {};
    for (const v of producto.producto_variantes) {
      for (const a of v.atributos) {
        ejes[a.Atributo] ??= [];
        if (!ejes[a.Atributo].includes(a.Valor)) ejes[a.Atributo].push(a.Valor);
      }
    }

    res.json({
      productoId: producto.Producto_ID,
      skuBase: producto.SKU_Codigo,
      nombre: producto.Nombre,
      matriz: producto.producto_variantes.map((v) => {
        const margenPropio = v.Margen_Ganancia != null ? Number(v.Margen_Ganancia) : null;
        return {
          varianteId: v.Variante_ID,
          sku: v.SKU_Variante,
          precio: Number(v.Precio_Venta),
          costo: Number(v.Costo_Unitario),
          stock: v.Stock_Actual,
          // Margen propio (null → la UI muestra "Heredado") y el resuelto
          // definitivo aplicado por la cascada Variante→Producto→Categoría.
          margenPropio,
          margenEfectivo: margenPropio ?? margenBase,
          atributos: Object.fromEntries(
            v.atributos.map((a) => [a.Atributo, a.Valor])
          ),
        };
      }),
      ejes,
    });
  } catch (error) {
    return responderErrorPrisma(res, error, {
      recurso: 'producto',
      contexto: 'obtener las variantes del',
    });
  }
};

/**
 * POST /api/productos/:id/variantes/bulk
 *
 * Alta masiva de variantes (producto cartesiano de atributos del UI).
 * Idempotente: hace upsert por SKU_Variante y teletransporta atributos.
 * Shape entrante: { variantes: [{ sku, atributos: {Atributo: Valor}, costo,
 *   precio, stock }] }
 */
export const crearVariantesBulk = async (req: Request, res: Response) => {
  try {
    const productoId = Number(req.params.id);
    const variantes = req.body?.variantes;
    if (!Number.isFinite(productoId)) {
      return res.status(400).json({ message: 'ID de producto inválido' });
    }
    if (!Array.isArray(variantes) || variantes.length === 0) {
      return res.status(400).json({ message: 'Se requiere al menos una variante' });
    }

    const producto = await prisma.productos.findUnique({
      where: { Producto_ID: productoId },
      select: { Producto_ID: true, SKU_Codigo: true },
    });
    if (!producto) return res.status(404).json({ message: 'Producto no encontrado' });

      const resultado = await prisma.$transaction(async (tx) => {
      const creadas: number[] = [];
      const actualizadas: number[] = [];
      for (const [i, v] of variantes.entries()) {
        const sku = String(v?.sku ?? `${producto.SKU_Codigo}-V${i + 1}`).trim();
        const atributos = (v?.atributos ?? {}) as Record<string, string>;

        // Preservación tolerante: null/undefined dejan intacto el valor
        // guardado previamente (para regenerar sin borrar datos actuales).
        const costo = v?.costo == null ? undefined : Number(v.costo);
        const precio = v?.precio == null ? undefined : Number(v.precio);
        const stock = v?.stock == null ? undefined : Number(v.stock);
        const imagen =
          typeof v?.imagen === 'string' ? v.imagen.trim() : undefined;

        const existente = await tx.producto_variantes.findUnique({
          where: { SKU_Variante: sku },
          select: { Variante_ID: true },
        });
        const fila = await tx.producto_variantes.upsert({
          where: { SKU_Variante: sku },
          create: {
            Producto_ID: productoId,
            SKU_Variante: sku,
            Costo_Unitario: costo ?? 0,
            Precio_Venta: precio ?? 0,
            Stock_Actual: stock ?? 0,
            Imagen_URL: imagen && imagen !== '' ? imagen : null,
          },
          update: {
            ...(costo !== undefined ? { Costo_Unitario: costo } : {}),
            ...(precio !== undefined ? { Precio_Venta: precio } : {}),
            ...(stock !== undefined ? { Stock_Actual: stock } : {}),
            ...(imagen !== undefined
              ? { Imagen_URL: imagen === '' ? null : imagen }
              : {}),
            Activo: true,
          },
        });
        // Sincronizar atributos: borra los anteriores y reinserta los nuevos
        // (volumen bajo por variante, simple y consistente).
        await tx.variante_atributos.deleteMany({ where: { Variante_ID: fila.Variante_ID } });
        const entradas = Object.entries(atributos)
          .filter(([k, val]) => k.trim() !== '' && String(val).trim() !== '');
        if (entradas.length > 0) {
          await tx.variante_atributos.createMany({
            data: entradas.map(([k, val]) => ({
              Variante_ID: fila.Variante_ID,
              Atributo: k.trim(),
              Valor: String(val).trim(),
            })),
          });
        }
        (existente == null ? creadas : actualizadas).push(fila.Variante_ID);
      }
      return { creadas: creadas.length, actualizadas: actualizadas.length };
    }, { timeout: 30000, maxWait: 20000 });

    // Alta/edición masiva puede cambiar stock, precio, costo y atributos.
    IoStore.emitDbUpdate('inventario', `Variantes sincronizadas para producto #${productoId}`, {
      productoId,
      creadas: resultado.creadas,
      actualizadas: resultado.actualizadas,
    });
    res.status(201).json({ ok: true, ...resultado });
  } catch (error: unknown) {
    if ((error as any)?.code === 'P2002') {
      const msg = 'SKU de variante en conflicto con otra existente';
      return res.status(409).json({ success: false, code: 'DUPLICADO', message: msg, error: msg });
    }
    return responderErrorPrisma(res, error, {
      recurso: 'variante',
      contexto: 'crear las',
    });
  }
};

/** PATCH /api/variantes/:id — edición rápida inline (stock/costo/precio). */
export const actualizarVariante = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ message: 'ID de variante inválido' });
    }
    const { stock, costo, precio, activo, margen, imagen } = req.body ?? {};
    const actualizada = await prisma.$transaction(async (tx) => {
      // La edición manual de stock de una variante debe serializarse frente
      // a ventas, entradas y reversas que también tocan esta fila.
      await tx.$queryRaw(Prisma.sql`
        SELECT Variante_ID
        FROM producto_variantes
        WHERE Variante_ID = ${id}
        FOR UPDATE
      `);

      return tx.producto_variantes
        .update({
          where: { Variante_ID: id },
        data: {
          Stock_Actual: stock !== undefined ? Number(stock) : undefined,
          Costo_Unitario: costo !== undefined ? Number(costo) : undefined,
          Precio_Venta: precio !== undefined ? Number(precio) : undefined,
          // margen: null explícito = "heredar" (quitar margen propio de la variante)
          Margen_Ganancia: margen !== undefined
            ? (margen === null ? null : Number(margen))
            : undefined,
          Activo: typeof activo === 'boolean' ? activo : undefined,
          // Imagen propia de la variante: cadena vacía limpia (vuelve a
          // heredar la del producto); undefined deja la actual.
          Imagen_URL:
            typeof imagen === 'string'
              ? (imagen.trim() === '' ? null : imagen.trim())
              : undefined,
        },
        })
        .catch(() => null);
    });
    if (!actualizada) {
      return res.status(404).json({ message: 'Variante no encontrada' });
    }
    IoStore.emitDbUpdate('inventario', `Variante actualizada (ID ${actualizada.Variante_ID})`, {
      varianteId: actualizada.Variante_ID,
      productoId: actualizada.Producto_ID,
    });
    res.json({
      varianteId: actualizada.Variante_ID,
      stock: Number(actualizada.Stock_Actual),
      costo: Number(actualizada.Costo_Unitario),
      precio: Number(actualizada.Precio_Venta),
      activo: actualizada.Activo,
    });
  } catch (error) {
    return responderErrorPrisma(res, error, {
      recurso: 'variante',
      contexto: 'actualizar la',
    });
  }
};

/**
 * DELETE /api/variantes/:id — SOFT DELETE (Activo=false).
 * Una variante con historial de ventas NUNCA se borra físicamente según la
 * regla fija de la trazabilidad fiscal (ejemplo: eliminar rompe el CSV y
 * los detalles de facturas pasadas). Se marca inactiva y desaparece del
 * GET de la matriz, conservando el SKU en el historial.
 */
export const eliminarVariante = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ message: 'ID de variante inválido' });
    }
    const variante = await prisma.producto_variantes.findUnique({
      where: { Variante_ID: id },
    });
    if (!variante) {
      return res.status(404).json({ message: 'Variante no encontrada' });
    }
    // Integridad: si tiene ventas históricas se preserva solo como inactiva;
    // la relación con detalle_facturas impide el borrado físico sin cascada.
    const vendida = await prisma.detalle_facturas.findFirst({
      where: { Variante_ID: id },
      select: { Detalle_ID: true },
    });
    await prisma.producto_variantes.update({
      where: { Variante_ID: id },
      data: { Activo: false },
    });
    IoStore.emitDbUpdate('inventario', `Variante desactivada (ID ${id})`, { varianteId: id });
    res.json({
      ok: true,
      eliminacionFisica: vendida == null,
      message: vendida == null
        ? 'Variante desactivada (topito a eliminar regenerando con el mismo SKU)'
        : 'Variante archivada (tiene historial de ventas)'
    });
  } catch (error) {
    return responderErrorPrisma(res, error, {
      recurso: 'variante',
      contexto: 'eliminar la',
    });
  }
};

export const deleteProducto = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    // BORRADO LÓGICO: se desactiva, no se borra. Antes el DELETE físico
    // fallaba con P2003 cuando el producto tenía facturas asociadas (y
    // borrarlo habría roto el historial). Ahora deja de venderse y las
    // facturas/notas conservan su referencia intacta.
    const actualizado = await prisma.productos.update({
      where: { Producto_ID: id },
      data: { Activo: false },
    });
    IoStore.emitDbUpdate('inventario', `Producto desactivado (ID ${id})`, { productoId: id });
    res.json({
      message: `Producto "${actualizado.Nombre}" desactivado. Ya no se vende; su historial queda intacto.`,
    });
  } catch (error) {
    return responderErrorPrisma(res, error, {
      recurso: 'producto',
      contexto: 'desactivar el',
    });
  }
};

/**
 * POST /productos/imagen — sube una imagen binaria y devuelve su ruta pública
 * `/productos/<archivo>`. Recibe el cuerpo en crudo con `express.raw` (sin
 * multer), lo que evita una dependencia extra. Límite: 8 MB.
 */
export const subirImagenProducto = async (req: Request, res: Response) => {
  try {
    const buf = req.body as Buffer;
    if (!Buffer.isBuffer(buf) || buf.length === 0) {
      return res.status(400).json({
        message:
          'Archivo vacío o tipo no soportado (envía image/png, image/jpeg o image/webp)',
      });
    }
    const mime = String(req.headers['content-type'] || '').toLowerCase();
    const ext = mime.includes('png')
      ? 'png'
      : mime.includes('jpeg') || mime.includes('jpg')
        ? 'jpg'
        : mime.includes('webp')
          ? 'webp'
          : mime.includes('gif')
            ? 'gif'
            : 'bin';
    const nombre = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

    // ── Persistencia ──────────────────────────────────────────────────────
    // Con R2 configurado la imagen va al bucket y sobrevive a los redeploys
    // de Render (disco efímero). Sin R2 se guarda en disco como antes.
    const r2Endpoint = process.env.R2_ENDPOINT;
    const r2Bucket = process.env.R2_BUCKET;
    const r2KeyId = process.env.R2_ACCESS_KEY_ID;
    const r2Secret = process.env.R2_SECRET_ACCESS_KEY;
    const r2Public = process.env.R2_PUBLIC_URL;

    if (r2Endpoint && r2Bucket && r2KeyId && r2Secret && r2Public) {
      const clave = `productos/${nombre}`;
      const s3 = new S3Client({
        region: 'auto',
        endpoint: r2Endpoint,
        forcePathStyle: true,
        credentials: {
          accessKeyId: r2KeyId,
          secretAccessKey: r2Secret,
        },
      });
      await s3.send(
        new PutObjectCommand({
          Bucket: r2Bucket,
          Key: clave,
          Body: buf,
          ContentType: mime.split(';')[0] || 'application/octet-stream',
        }),
      );
      return res.status(201).json({
        url: `${r2Public.replace(/\/$/, '')}/${clave}`,
      });
    }

    const dir = process.env.PRODUCTOS_DIR
      ? path.resolve(process.env.PRODUCTOS_DIR)
      : path.resolve(__dirname, '../../public/productos');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, nombre), buf);
    return res.status(201).json({ url: `/productos/${nombre}` });
  } catch (error) {
    return responderErrorPrisma(res, error, {
      recurso: 'imagen',
      contexto: 'subir la',
    });
  }
};