import { Request, Response } from 'express';
import { prisma } from '../config/db';
import { siguienteSkuPorCategoria } from '../utils/sku';
import { responderErrorPrisma } from '../utils/errores';
import { IoStore } from '../utils/socket';

const REGEX_PREFIJO = /^[A-Z]{3}$/;

export const getCategorias = async (_req: Request, res: Response) => {
  try {
    const categorias = await prisma.categorias.findMany();
    res.json(categorias);
  } catch (error) {
    return responderErrorPrisma(res, error, {
      recurso: 'categoría',
      contexto: 'obtener',
    });
  }
};

export const updateCategoria = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const idNum = Number(id);
    if (!Number.isInteger(idNum) || idNum <= 0) {
      return res.status(400).json({
        success: false,
        code: 'NULO_INVALIDO',
        message: 'ID de categoría inválido',
      });
    }
    const { Nombre, Prefijo_SKU, Descripcion, Activo, Margen_Sugerido } = req.body;

    if (Prefijo_SKU !== undefined && !REGEX_PREFIJO.test(Prefijo_SKU)) {
      return res.status(400).json({
        success: false,
        code: 'NULO_INVALIDO',
        message: 'Prefijo_SKU debe ser de 3 letras mayúsculas (ej. PIN, HER, ELE)',
      });
    }

    const categoriaActualizada = await prisma.categorias.update({
      where: { Categoria_ID: idNum },
      data: {
        Nombre,
        Prefijo_SKU,
        Descripcion,
        Margen_Sugerido: Margen_Sugerido !== undefined
          ? (Margen_Sugerido === null ? null : Number(Margen_Sugerido))
          : undefined,
        Activo: Activo !== undefined ? Activo : undefined
      }
    });

    IoStore.emitDbUpdate('categorias', `Categoría actualizada: ${categoriaActualizada.Nombre}`, { categoriaId: categoriaActualizada.Categoria_ID });
    res.json(categoriaActualizada);
  } catch (error) {
    // Mapeo uniforme: P2025 → 404, P2002 → 409, resto → 500 coherente.
    return responderErrorPrisma(res, error, {
      recurso: 'categoría',
      contexto: 'actualizar',
    });
  }
};

export const deleteCategoria = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const idNum = Number(id);
    if (!Number.isInteger(idNum) || idNum <= 0) {
      return res.status(400).json({
        success: false,
        code: 'NULO_INVALIDO',
        message: 'ID de categoría inválido',
      });
    }
    // Eliminación lógica: se desactiva en lugar de borrar físicamente,
    // para no romper las referencias con productos existentes.
    const categoria = await prisma.categorias.update({
      where: { Categoria_ID: idNum },
      data: { Activo: false }
    });

    IoStore.emitDbUpdate('categorias', `Categoría desactivada: ${categoria.Nombre}`, { categoriaId: categoria.Categoria_ID });
    res.json({ message: 'Categoría desactivada correctamente', categoria });
  } catch (error) {
    return responderErrorPrisma(res, error, {
      recurso: 'categoría',
      contexto: 'eliminar',
    });
  }
};

export const createCategoria = async (req: Request, res: Response) => {
  try {
    const { Nombre, Prefijo_SKU, Descripcion, Margen_Sugerido } = req.body;

    if (!Nombre || !String(Nombre).trim()) {
      return res.status(400).json({ message: 'El nombre de la categoría es obligatorio' });
    }

    // Prefijo SKU: opcional para el cajero. Si no se envía, se deriva de las
    // 3 primeras letras del nombre (o GEN si no alcanza). Si se envía,
    // se valida el formato fiscal esperado.
    let prefijo = (Prefijo_SKU ?? '').toString().trim().toUpperCase();
    if (prefijo === '') {
      const base = String(Nombre).trim().toUpperCase().replace(/[^A-Z]/g, '');
      prefijo = base.length >= 3 ? base.substring(0, 3) : 'GEN';
    } else if (!REGEX_PREFIJO.test(prefijo)) {
      return res.status(400).json({
        message: 'Prefijo_SKU debe ser de 3 letras mayúsculas (ej. PIN, HER, ELE)'
      });
    }

    const nuevaCategoria = await prisma.categorias.create({
      data: {
        Nombre: String(Nombre).trim(),
        Prefijo_SKU: prefijo,
        Descripcion,
        Margen_Sugerido: Margen_Sugerido !== undefined && Margen_Sugerido !== null
          ? Number(Margen_Sugerido)
          : null,
      }
    });

    IoStore.emitDbUpdate('categorias', `Categoría registrada: ${nuevaCategoria.Nombre}`, { categoriaId: nuevaCategoria.Categoria_ID });
    res.status(201).json(nuevaCategoria);
  } catch (error) {
    // P2002 (nombre/prefijo duplicado) → 409 legible; el resto vía mapeo común.
    return responderErrorPrisma(res, error, {
      recurso: 'categoría',
      contexto: 'registrar',
    });
  }
};

// Vista previa para el frontend: sugiere el próximo SKU de la categoría
export const getSiguienteSku = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const sku = await siguienteSkuPorCategoria(prisma, Number(id));

    if (!sku) {
      return res.status(404).json({
        success: false,
        code: 'NO_ENCONTRADO',
        message: 'Categoría no encontrada',
      });
    }
    res.json({ sku_sugerido: sku });
  } catch (error) {
    return responderErrorPrisma(res, error, {
      recurso: 'categoría',
      contexto: 'calcular el siguiente SKU de',
    });
  }
};