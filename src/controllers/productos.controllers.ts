import { Request, Response } from 'express';
import { prisma } from '../config/db';

export const getProductos = async (_req: Request, res: Response) => {
  try {
    const productos = await prisma.productos.findMany({
      include: { categorias: true }
    });
    res.json(productos);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener productos', error });
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

    if (!SKU_Codigo || !Nombre || !Categoria_ID) {
      return res.status(400).json({ 
        message: 'SKU_Codigo, Nombre y Categoria_ID son obligatorios' 
      });
    }

    const nuevoProducto = await prisma.productos.create({
      data: {
        SKU_Codigo,
        Nombre,
        Precio_Venta: Precio_Venta || 0,
        Costo_Promedio: Costo_Promedio || 0,
        Stock_Actual: Stock_Actual || 0,
        Stock_Minimo: Stock_Minimo || 5,
        Categoria_ID
      }
    });

    res.status(201).json(nuevoProducto);
  } catch (error) {
    console.error('Error detallado:', error);
    res.status(500).json({ message: 'Error al registrar el producto', error });
  }
};