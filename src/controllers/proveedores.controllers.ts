import { Request, Response } from 'express';
import { prisma } from '../config/db';

export const getProveedores = async (_req: Request, res: Response) => {
  try {
    const proveedores = await prisma.proveedores.findMany();
    res.json(proveedores);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener proveedores', error });
  }
};

export const createProveedor = async (req: Request, res: Response) => {
  try {
    const { RIF_Cedula, Razon_Social, Telefono, Email, Direccion } = req.body;

    if (!RIF_Cedula || !Razon_Social) {
      return res.status(400).json({ message: 'RIF_Cedula y Razon_Social son obligatorios' });
    }

    const nuevoProveedor = await prisma.proveedores.create({
      data: { RIF_Cedula, Razon_Social, Telefono, Email, Direccion }
    });

    res.status(201).json(nuevoProveedor);
  } catch (error) {
    res.status(500).json({ message: 'Error al registrar el proveedor', error });
  }
};