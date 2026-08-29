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

export const buscarClientePorDocumento = async (req: Request, res: Response) => {
  try {
    const { documento } = req.query;
    if (!documento) {
      return res.status(400).json({ message: 'El parámetro documento es requerido' });
    }

    const cliente = await prisma.clientes.findFirst({
      where: { RIF_Cedula: { contains: String(documento) } }
    });

    if (!cliente) {
      return res.status(404).json({ message: 'Cliente no encontrado' });
    }

    return res.json(cliente);
  } catch (error) {
    return res.status(500).json({ message: 'Error al buscar cliente', error });
  }
};

export const updateCliente = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { RIF_Cedula, Razon_Social, Direccion, Telefono, Email } = req.body;

    const clienteActualizado = await prisma.clientes.update({
      where: { Cliente_ID: Number(id) },
      data: { RIF_Cedula, Razon_Social, Direccion, Telefono, Email }
    });

    res.json(clienteActualizado);
  } catch (error) {
    res.status(500).json({ message: 'Error al actualizar el cliente', error });
  }
};

export const deleteCliente = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await prisma.clientes.delete({
      where: { Cliente_ID: Number(id) }
    });
    res.json({ message: 'Cliente eliminado correctamente' });
  } catch (error) {
    res.status(500).json({ message: 'Error al eliminar el cliente', error });
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