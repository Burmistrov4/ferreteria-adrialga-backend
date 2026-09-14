import { Request, Response } from 'express';
import { prisma } from '../config/db';

/**
 * Configuración legal de la tienda (encabezado de facturas/PDF).
 * Una sola fila. Si la tabla está vacía se responde con valores de
 * défaut seguros para evitar NPE en el generador de PDF del frontend.
 */
const FALLBACK = {
  nombre: 'Ferretería Adrialga C.A.',
  rif: 'J-00000000-0',
  direccion: 'Dirección no configurada',
  telefono: '0000-0000000',
};

export const getConfiguracion = async (_req: Request, res: Response) => {
  try {
    const config = await prisma.configuracion_tienda.findFirst();
    if (!config) return res.json(FALLBACK);
    res.json({
      nombre: config.Nombre,
      rif: config.RIF,
      direccion: config.Direccion,
      telefono: config.Telefono,
    });
  } catch (error) {
    console.error('Error al obtener configuración:', error);
    // Ante fallo de BD el fallback sigue asegurando la emisión del PDF.
    res.json(FALLBACK);
  }
};

export const updateConfiguracion = async (req: Request, res: Response) => {
  try {
    const { nombre, rif, direccion, telefono } = req.body ?? {};
    if (!nombre || !rif || !direccion) {
      return res.status(400).json({
        message: 'nombre, rif y direccion son obligatorios',
      });
    }
    const actual = await prisma.configuracion_tienda.findFirst();
    const data = {
      Nombre: String(nombre).trim(),
      RIF: String(rif).toUpperCase().trim(),
      Direccion: String(direccion).trim(),
      Telefono: String(telefono ?? '').trim(),
    };
    const guardada = actual
      ? await prisma.configuracion_tienda.update({
          where: { Config_ID: actual.Config_ID },
          data,
        })
      : await prisma.configuracion_tienda.create({ data });
    res.json({
      nombre: guardada.Nombre,
      rif: guardada.RIF,
      direccion: guardada.Direccion,
      telefono: guardada.Telefono,
    });
  } catch (error) {
    console.error('Error al actualizar configuración:', error);
    res.status(500).json({ message: 'Error al guardar la configuración' });
  }
};
