import { Request, Response } from 'express';
import { prisma } from '../config/db';
import { siguienteSkuPorCategoria } from '../utils/sku';

const REGEX_PREFIJO = /^[A-Z]{3}$/;

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
    const { Nombre, Prefijo_SKU, Descripcion, Activo } = req.body;

    if (Prefijo_SKU !== undefined && !REGEX_PREFIJO.test(Prefijo_SKU)) {
      return res.status(400).json({
        message: 'Prefijo_SKU debe ser de 3 letras mayúsculas (ej. PIN, HER, ELE)'
      });
    }

    const categoriaActualizada = await prisma.categorias.update({
      where: { Categoria_ID: Number(id) },
      data: {
        Nombre,
        Prefijo_SKU,
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
    const { Nombre, Prefijo_SKU, Descripcion } = req.body;

    if (!Nombre) {
      return res.status(400).json({ message: 'El nombre de la categoría es obligatorio' });
    }
    if (!Prefijo_SKU || !REGEX_PREFIJO.test(Prefijo_SKU)) {
      return res.status(400).json({
        message: 'Prefijo_SKU es obligatorio y debe ser de 3 letras mayúsculas (ej. PIN, HER, ELE)'
      });
    }

    const nuevaCategoria = await prisma.categorias.create({
      data: {
        Nombre,
        Prefijo_SKU,
        Descripcion
      }
    });

    res.status(201).json(nuevaCategoria);
  } catch (error) {
    console.error('Error detallado de Prisma:', error);
    res.status(500).json({ message: 'Error al registrar la categoría', error });
  }
};

// Vista previa para el frontend: sugiere el próximo SKU de la categoría
export const getSiguienteSku = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const sku = await siguienteSkuPorCategoria(prisma, Number(id));

    if (!sku) {
      return res.status(404).json({ message: 'Categoría no encontrada' });
    }
    res.json({ sku_sugerido: sku });
  } catch (error) {
    console.error('Error al calcular el siguiente SKU:', error);
    res.status(500).json({ message: 'Error al calcular el siguiente SKU', error });
  }
};