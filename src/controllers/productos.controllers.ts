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
    console.error('Error al obtener variantes:', error);
    res.status(500).json({ message: 'Error al obtener las variantes' });
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
        const costo = Number(v?.costo ?? 0) || 0;
        const precio = Number(v?.precio ?? 0) || 0;
        const stock = Number(v?.stock ?? 0) || 0;
        const atributos = (v?.atributos ?? {}) as Record<string, string>;

        const existente = await tx.producto_variantes.findUnique({
          where: { SKU_Variante: sku },
          select: { Variante_ID: true },
        });
        const fila = await tx.producto_variantes.upsert({
          where: { SKU_Variante: sku },
          create: { Producto_ID: productoId, SKU_Variante: sku, Costo_Unitario: costo, Precio_Venta: precio, Stock_Actual: stock },
          update: { Costo_Unitario: costo, Precio_Venta: precio, Stock_Actual: stock },
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
    });

    res.status(201).json({ ok: true, ...resultado });
  } catch (error: any) {
    if (error?.code === 'P2002') {
      return res
        .status(409)
        .json({ message: 'SKU de variante en conflicto con otra existente' });
    }
    console.error('Error en bulk de variantes:', error);
    res.status(500).json({ message: 'Error al crear las variantes' });
  }
};

/** PATCH /api/variantes/:id — edición rápida inline (stock/costo/precio). */
export const actualizarVariante = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ message: 'ID de variante inválido' });
    }
    const { stock, costo, precio, activo, margen } = req.body ?? {};
    const actualizada = await prisma.producto_variantes
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
        },
      })
      .catch(() => null);
    if (!actualizada) {
      return res.status(404).json({ message: 'Variante no encontrada' });
    }
    res.json({
      varianteId: actualizada.Variante_ID,
      stock: Number(actualizada.Stock_Actual),
      costo: Number(actualizada.Costo_Unitario),
      precio: Number(actualizada.Precio_Venta),
      activo: actualizada.Activo,
    });
  } catch (error) {
    console.error('Error al actualizar variante:', error);
    res.status(500).json({ message: 'Error al actualizar la variante' });
  }
};

export const deleteProducto = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    // Eliminar primero las variantes del producto (y sus atributos por
    // cascade del FK) para no dejar SKUs huérfanos que colisionen con el
    // bulk de otro producto.
    await prisma.$transaction([
      prisma.producto_variantes.deleteMany({ where: { Producto_ID: id } }),
      prisma.productos.delete({ where: { Producto_ID: id } }),
    ]);
    res.json({ message: 'Producto eliminado correctamente' });
  } catch (error) {
    res.status(500).json({ message: 'Error al eliminar el producto', error });
  }
};