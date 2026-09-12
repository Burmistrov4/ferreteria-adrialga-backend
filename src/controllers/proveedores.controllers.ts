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

export const updateProveedor = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ message: 'ID de proveedor inválido' });
    }
    const { Razon_Social, Telefono, Email, Direccion } = req.body;
    if (!Razon_Social) {
      return res.status(400).json({ message: 'Razon_Social es obligatoria' });
    }
    const actualizado = await prisma.proveedores.update({
      where: { Proveedor_ID: id },
      data: { Razon_Social, Telefono, Email, Direccion }
    });
    res.json(actualizado);
  } catch (error: any) {
    if (error?.code === 'P2025') {
      return res.status(404).json({ message: 'Proveedor no encontrado' });
    }
    res.status(500).json({ message: 'Error al actualizar el proveedor', error });
  }
};

export const deleteProveedor = async (req: Request, res: Response) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) {
      return res.status(400).json({ message: 'ID de proveedor inválido' });
    }
    // Integridad referencial: no se puede eliminar si tiene compras registradas
    const compras = await prisma.notas_entrega_entrada.count({
      where: { Proveedor_ID: id }
    });
    if (compras > 0) {
      return res.status(409).json({
        message: `No se puede eliminar: el proveedor tiene ${compras} compra(s) registrada(s)`
      });
    }
    const cxpPendientes = await prisma.cuentas_por_pagar.count({
      where: { Proveedor_ID: id, Estatus: { not: 'Pagada' } }
    });
    if (cxpPendientes > 0) {
      return res.status(409).json({
        message: `No se puede eliminar: el proveedor tiene ${cxpPendientes} cuenta(s) por pagar pendiente(s)`
      });
    }
    await prisma.proveedores.delete({ where: { Proveedor_ID: id } });
    res.json({ ok: true, message: 'Proveedor eliminado' });
  } catch (error: any) {
    if (error?.code === 'P2025') {
      return res.status(404).json({ message: 'Proveedor no encontrado' });
    }
    res.status(500).json({ message: 'Error al eliminar el proveedor', error });
  }
};