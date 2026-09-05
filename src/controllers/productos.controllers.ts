import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { siguienteSkuPorCategoria } from '../utils/sku';

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
      Stock_Actual,
      Stock_Minimo,
      Categoria_ID
    } = req.body;

    if (!Nombre || !Categoria_ID) {
      return res.status(400).json({
        message: 'Nombre y Categoria_ID son obligatorios'
      });
    }

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
          Precio_Venta: Number(Precio_Venta) || 0,
          Costo_Promedio: Number(Costo_Promedio) || 0,
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
      Stock_Actual, 
      Stock_Minimo, 
      Categoria_ID 
    } = req.body;

    const productoActualizado = await prisma.productos.update({
      where: { Producto_ID: Number(id) },
      data: {
        SKU_Codigo,
        Nombre,
        Precio_Venta: Precio_Venta !== undefined ? Number(Precio_Venta) : undefined,
        Costo_Promedio: Costo_Promedio !== undefined ? Number(Costo_Promedio) : undefined,
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