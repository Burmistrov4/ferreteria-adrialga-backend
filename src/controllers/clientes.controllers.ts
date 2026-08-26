import { Request, Response } from 'express';
import { prisma } from '../config/db';

export const getClientes = async (_req: Request, res: Response) => {
  try {
    const clientes = await prisma.clientes.findMany();
    res.json(clientes);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener clientes', error });
  }
};

export const createCliente = async (req: Request, res: Response) => {
  try {
    const { RIF_Cedula, Razon_Social, Direccion, Telefono, Email } = req.body;

    if (!RIF_Cedula || !Razon_Social) {
      return res.status(400).json({ message: 'RIF_Cedula y Razon_Social son obligatorios' });
    }

    const nuevoCliente = await prisma.clientes.create({
      data: { RIF_Cedula, Razon_Social, Direccion, Telefono, Email }
    });

    res.status(201).json(nuevoCliente);
  } catch (error) {
    res.status(500).json({ message: 'Error al registrar el cliente', error });
  }
};