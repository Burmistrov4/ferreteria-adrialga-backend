import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { siguienteSkuPorCategoria } from '../utils/sku';

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

export const getProductos = async (_req: Request, res: Response) => {
  try {
    const productos = await prisma.productos.findMany({
      include: { categorias: true },
      orderBy: { Producto_ID: 'desc' }
    });
    res.json(productos);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener productos', error });
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
    res.status(500).json({ message: 'Error al obtener el producto', error });
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
          Categoria_ID: Number(Categoria_ID)
        },
        include: { categorias: true }
      });
    });

    res.status(201).json(nuevoProducto);
  } catch (error) {
    if (error instanceof Error && error.message === 'CATEGORIA_NO_ENCONTRADA') {
      return res.status(404).json({ message: 'La categoría indicada no existe' });
    }
    // Colisión por SKU duplicado (restricción @unique)
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      return res.status(409).json({
        message: 'El código SKU ya existe. Refresque la sugerencia o ingrese uno diferente.'
      });
    }
    console.error('Error al registrar producto:', error);
    res.status(500).json({ message: 'Error al registrar el producto', error });
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

    const productoActualizado = await prisma.productos.update({
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
        Categoria_ID: Categoria_ID !== undefined ? Number(Categoria_ID) : undefined
      },
      include: { categorias: true }
    });

    res.json(productoActualizado);
  } catch (error) {
    console.error('Error al actualizar producto:', error);
    res.status(500).json({ message: 'Error al actualizar el producto', error });
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
      matriz: producto.producto_variantes.map((v) => ({
        varianteId: v.Variante_ID,
        sku: v.SKU_Variante,
        precio: Number(v.Precio_Venta),
        costo: Number(v.Costo_Unitario),
        stock: v.Stock_Actual,
        atributos: Object.fromEntries(
          v.atributos.map((a) => [a.Atributo, a.Valor])
        ),
      })),
      ejes,
    });
  } catch (error) {
    console.error('Error al obtener variantes:', error);
    res.status(500).json({ message: 'Error al obtener las variantes' });
  }
};

export const deleteProducto = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await prisma.productos.delete({
      where: { Producto_ID: Number(id) }
    });
    res.json({ message: 'Producto eliminado correctamente' });
  } catch (error) {
    res.status(500).json({ message: 'Error al eliminar el producto', error });
  }
};