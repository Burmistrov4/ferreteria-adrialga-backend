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
  mensajePie: 'Gracias por su compra',
  margenDefecto: 0,
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
      mensajePie: config.Mensaje_Pie,
      margenDefecto: Number(config.Margen_Defecto),
    });
  } catch (error) {
    console.error('Error al obtener configuración:', error);
    // Ante fallo de BD el fallback sigue asegurando la emisión del PDF.
    res.json(FALLBACK);
  }
};

export const updateConfiguracion = async (req: Request, res: Response) => {
  try {
    const { nombre, rif, direccion, telefono, mensajePie, margenDefecto } =
      req.body ?? {};
    if (!nombre || !rif || !direccion) {
      return res.status(400).json({
        message: 'nombre, rif y direccion son obligatorios',
      });
    }
    const margenNum = Number(margenDefecto ?? 0);
    if (!Number.isFinite(margenNum) || margenNum < 0 || margenNum > 1000) {
      return res
        .status(400)
        .json({ message: 'Margen por defecto debe estar entre 0 y 1000%' });
    }
    const actual = await prisma.configuracion_tienda.findFirst();
    const data = {
      Nombre: String(nombre).trim(),
      RIF: String(rif).toUpperCase().trim(),
      Direccion: String(direccion).trim(),
      Telefono: String(telefono ?? '').trim(),
      Mensaje_Pie: String(mensajePie ?? '').trim(),
      Margen_Defecto: margenNum,
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
      mensajePie: guardada.Mensaje_Pie,
      margenDefecto: Number(guardada.Margen_Defecto),
    });
  } catch (error) {
    console.error('Error al actualizar configuración:', error);
    res.status(500).json({ message: 'Error al guardar la configuración' });
  }
};
