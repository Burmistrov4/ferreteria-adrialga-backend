import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { IoStore } from '../utils/socket';
import { responderErrorPrisma } from '../utils/errores';

// ── Normalización de documento ───────────────────────────────────────────────
// Sincronización bidireccional entre RIF_Cedula y el par Tipo_Documento /
// Num_Documento. Acepta cualquiera de las tres representaciones de entrada y
// garantiza que las tres queden consistentes en la base de datos.
//   "V-12345678"  → tipo 'V', num '12345678'
//   { tipo: 'J', num: '405837357' } → rif 'J-405837357'
function normalizarDocumento(input: {
  RIF_Cedula?: string | null;
  Tipo_Documento?: string | null;
  Num_Documento?: string | null;
}) {
  let rif = (input.RIF_Cedula ?? '').toString().trim().toUpperCase();
  let tipo = (input.Tipo_Documento ?? '').toString().trim().toUpperCase();
  let num = (input.Num_Documento ?? '').toString().trim();

  // Derivar desde el RIF completo si no llegaron separados
  if (rif.includes('-') && (!tipo || !num)) {
    const [t, ...resto] = rif.split('-');
    if (!tipo) tipo = t;
    if (!num) num = resto.join('-');
  }
  if (!tipo && !num && rif) {
    num = rif;
  }
  if (!tipo) tipo = 'V';

  // Reconstruir el RIF canónico desde el par Tipo/Num cuando difiere
  const rifCanonico = num ? `${tipo}-${num}` : rif;
  if (!rif || rif !== rifCanonico) rif = rifCanonico;

  return { RIF_Cedula: rif, Tipo_Documento: tipo, Num_Documento: num };
}

// Motor de búsqueda compartido: filtra simultáneamente por Nombre / Razón
// Social, RIF completo o número de documento. La insensibilidad a
// mayúsculas/minúsculas la provee la colación (utf8mb4_*_ci) de MySQL, ya que
// el conector MySQL de Prisma no soporta mode: 'insensitive'.
function construirWhereBusqueda(q: string): Prisma.clientesWhereInput {
  const query = q.trim();
  if (!query) return {};
  return {
    OR: [
      { Razon_Social: { contains: query } },
      { RIF_Cedula: { contains: query } },
      { Num_Documento: { contains: query } }
    ]
  };
}

export const getClientes = async (req: Request, res: Response) => {
  try {
    const q = (req.query.q ?? req.query.search ?? '').toString();
    // ?limit=N: devuelve los N clientes más recientes (por orden de registro)
    // para el autoload del selector de clientes en el POS.
    const limit = parseInt(req.query.limit?.toString() ?? '', 10);
    const usarRecientes = Number.isInteger(limit) && limit > 0;
    const clientes = await prisma.clientes.findMany({
      where: construirWhereBusqueda(q),
      orderBy: usarRecientes ? { Cliente_ID: 'desc' } : { Razon_Social: 'asc' },
      ...(usarRecientes ? { take: limit } : {})
    });
    res.json(clientes);
  } catch (error) {
    return responderErrorPrisma(res, error, {
      recurso: 'cliente',
      contexto: 'obtener los',
    });
  }
};

// Búsqueda flexible (documento y/o nombre). Devuelve una LISTA para que el
// cliente pueda desambiguar coincidencias parciales (antes usaba findFirst,
// que devolvía un registro arbitrario).
export const buscarClientePorDocumento = async (req: Request, res: Response) => {
  try {
    const q = (req.query.documento ?? req.query.q ?? '').toString();
    if (!q.trim()) {
      return res.status(400).json({ message: 'El parámetro de búsqueda es requerido' });
    }

    const clientes = await prisma.clientes.findMany({
      where: construirWhereBusqueda(q),
      take: 20,
      orderBy: { Razon_Social: 'asc' }
    });

    return res.json(clientes);
  } catch (error) {
    return responderErrorPrisma(res, error, {
      recurso: 'cliente',
      contexto: 'buscar el',
    });
  }
};

export const updateCliente = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { Razon_Social, Direccion, Telefono, Email } = req.body;
    const doc = normalizarDocumento(req.body);

    const clienteActualizado = await prisma.clientes.update({
      where: { Cliente_ID: Number(id) },
      data: {
        RIF_Cedula: doc.RIF_Cedula,
        Tipo_Documento: doc.Tipo_Documento,
        Num_Documento: doc.Num_Documento,
        Razon_Social,
        Direccion,
        Telefono,
        Email
      }
    });

    IoStore.emitDbUpdate('clientes', `Cliente actualizado: ${clienteActualizado.Razon_Social}`, { clienteId: clienteActualizado.Cliente_ID });
    res.json(clienteActualizado);
  } catch (error: unknown) {
    const msg = 'Ya existe otro cliente con ese RIF/Cédula';
    if ((error as any)?.code === 'P2002') {
      return res.status(409).json({ success: false, code: 'DUPLICADO', message: msg, error: msg });
    }
    // P2025 -> 404 (cliente inexistente) en vez de 500.
    return responderErrorPrisma(res, error, {
      recurso: 'cliente',
      contexto: 'actualizar el',
    });
  }
};

export const deleteCliente = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    await prisma.clientes.delete({
      where: { Cliente_ID: Number(id) }
    });
    IoStore.emitDbUpdate('clientes', 'Cliente eliminado', { clienteId: Number(id) });
    res.json({ message: 'Cliente eliminado correctamente' });
  } catch (error: unknown) {
    const msg = 'No se puede eliminar: el cliente tiene facturas asociadas';
    if ((error as any)?.code === 'P2003') {
      return res.status(409).json({ success: false, code: 'FK_INVALIDA', message: msg, error: msg });
    }
    return responderErrorPrisma(res, error, {
      recurso: 'cliente',
      contexto: 'eliminar el',
    });
  }
};

export const createCliente = async (req: Request, res: Response) => {
  try {
    const { Razon_Social, Direccion, Telefono, Email } = req.body;
    const doc = normalizarDocumento(req.body);

    if (!doc.RIF_Cedula || !Razon_Social) {
      return res.status(400).json({ message: 'RIF/Cédula y Razón Social son obligatorios' });
    }

    const nuevoCliente = await prisma.clientes.create({
      data: {
        RIF_Cedula: doc.RIF_Cedula,
        Tipo_Documento: doc.Tipo_Documento,
        Num_Documento: doc.Num_Documento,
        Razon_Social,
        Direccion,
        Telefono,
        Email
      }
    });

    IoStore.emitDbUpdate('clientes', `Cliente registrado: ${nuevoCliente.Razon_Social}`, { clienteId: nuevoCliente.Cliente_ID });
    res.status(201).json(nuevoCliente);
  } catch (error: unknown) {
    const msg = 'Ya existe un cliente registrado con ese documento';
    if ((error as any)?.code === 'P2002') {
      return res.status(409).json({ success: false, code: 'DUPLICADO', message: msg, error: msg });
    }
    return responderErrorPrisma(res, error, {
      recurso: 'cliente',
      contexto: 'registrar el',
    });
  }
};