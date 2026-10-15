import { Request, Response } from 'express';
import { prisma } from '../config/db';
import { responderErrorPrisma } from '../utils/errores';
import { IoStore } from '../utils/socket';

export const getProveedores = async (_req: Request, res: Response) => {
  try {
    const proveedores = await prisma.proveedores.findMany();
    res.json(proveedores);
  } catch (error) {
    return responderErrorPrisma(res, error, {
      recurso: 'proveedor',
      contexto: 'obtener los',
    });
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

    // Broadcast LAN: las pantallas con selector de proveedor (p.ej. Entradas de
    // Mercancía) refrescan su lista en vivo, sin recargar la página.
    IoStore.emitDbUpdate('proveedores', `Proveedor registrado: ${Razon_Social}`, {
      proveedorId: nuevoProveedor.Proveedor_ID,
    });
    res.status(201).json(nuevoProveedor);
  } catch (error: any) {
    // Captura del error EXACTO de la consulta SQL/Prisma. Se mapea el
    // código a un mensaje accionable para que el frontend (y el cajero)
    // sepan qué corregir en lugar de recibir un 500 opaco.
    const code = error?.code; // p.ej. P2002, P2009, P2003, P2011
    const meta = error?.meta;

    if (code === 'P2002') {
      // Violación de restricción única (RIF_Cedula ya existe).
      const campo = (Array.isArray(meta?.target) ? meta.target : [meta?.target])
        .filter(Boolean)
        .join(', ');
      return res.status(409).json({
        success: false,
        code: 'DUPLICADO',
        message: `Ya existe un proveedor con ese ${campo || 'valor único'}.`,
      });
    }
    if (code === 'P2009' || code === 'P2011') {
      // Columna declarada NOT NULL recibió null, o valor fuera de rango.
      return res.status(400).json({
        success: false,
        code: 'NULO_INVALIDO',
        message:
          'Faltan campos obligatorios o algún valor excede la longitud permitida.',
      });
    }
    if (code === 'P2003') {
      // FK inválida (no debería ocurrir en alta, pero se cubre por robustez).
      return res.status(400).json({
        success: false,
        code: 'FK_INVALIDA',
        message: 'La referencia a otro registro no es válida.',
      });
    }

    // Contrato uniforme: sin filtrar el mensaje crudo de Prisma al cliente.
    return responderErrorPrisma(res, error, {
      recurso: 'proveedor',
      contexto: 'registrar el',
    });
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
    IoStore.emitDbUpdate('proveedores', `Proveedor actualizado: ${Razon_Social}`, {
      proveedorId: id,
    });
    res.json(actualizado);
  } catch (error: any) {
    if (error?.code === 'P2025') {
      return res.status(404).json({ success: false, code: 'NO_ENCONTRADO', message: 'Proveedor no encontrado' });
    }
    if (error?.code === 'P2002') {
      const campo = (Array.isArray(error?.meta?.target) ? error.meta.target : [error?.meta?.target])
        .filter(Boolean)
        .join(', ');
      return res.status(409).json({
        success: false,
        code: 'DUPLICADO',
        message: `Ya existe otro proveedor con ese ${campo || 'valor único'}.`,
      });
    }
    return responderErrorPrisma(res, error, {
      recurso: 'proveedor',
      contexto: 'actualizar el',
    });
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
    IoStore.emitDbUpdate('proveedores', 'Proveedor eliminado', { proveedorId: id });
    res.json({ ok: true, message: 'Proveedor eliminado' });
  } catch (error: unknown) {
    if ((error as any)?.code === 'P2025') {
      const msg = 'Proveedor no encontrado';
      return res
          .status(404)
          .json({ success: false, code: 'NO_ENCONTRADO', message: msg, error: msg });
    }
    // P2003: el proveedor esta referenciado por notas de entrega.
    return responderErrorPrisma(res, error, {
      recurso: 'proveedor',
      contexto: 'eliminar el',
    });
  }
};