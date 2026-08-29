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

export const updateCategoria = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { Nombre, Descripcion, Activo } = req.body;

    const categoriaActualizada = await prisma.categorias.update({
      where: { Categoria_ID: Number(id) },
      data: {
        Nombre,
        Descripcion,
        Activo: Activo !== undefined ? Activo : undefined
      }
    });

    res.json(categoriaActualizada);
  } catch (error) {
    console.error('Error al actualizar la categoría:', error);
    res.status(500).json({ message: 'Error al actualizar la categoría', error });
  }
};

export const deleteCategoria = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    // Eliminación lógica: se desactiva en lugar de borrar físicamente,
    // para no romper las referencias con productos existentes.
    const categoria = await prisma.categorias.update({
      where: { Categoria_ID: Number(id) },
      data: { Activo: false }
    });

    // Si por algún motivo la desactivación falla, se intenta el borrado lógico
    res.json({ message: 'Categoría desactivada correctamente', categoria });
  } catch (error) {
    console.error('Error al eliminar la categoría:', error);
    res.status(500).json({ message: 'Error al eliminar la categoría', error });
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