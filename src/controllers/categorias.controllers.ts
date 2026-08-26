import { Request, Response } from 'express';
import { prisma } from '../config/db';

export const getCategorias = async (_req: Request, res: Response) => {
  try {
    const categorias = await prisma.categorias.findMany();
    res.json(categorias);
  } catch (error) {
    console.error('Error al obtener categorías:', error);
    res.status(500).json({ message: 'Error al obtener categorías', error });
  }
};

export const createCategoria = async (req: Request, res: Response) => {
  try {
    const { Nombre, Descripcion } = req.body;

    if (!Nombre) {
      return res.status(400).json({ message: 'El nombre de la categoría es obligatorio' });
    }

    const nuevaCategoria = await prisma.categorias.create({
      data: { 
        Nombre, 
        Descripcion 
      }
    });

    res.status(201).json(nuevaCategoria);
  } catch (error) {
    console.error('Error detallado de Prisma:', error);
    res.status(500).json({ message: 'Error al registrar la categoría', error });
  }
};