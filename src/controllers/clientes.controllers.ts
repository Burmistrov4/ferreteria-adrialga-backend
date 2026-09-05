import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/db';

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
    res.status(500).json({ message: 'Error al obtener clientes', error });
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
    return res.status(500).json({ message: 'Error al buscar cliente', error });
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

    res.json(clienteActualizado);
  } catch (error: any) {
    if (error?.code === 'P2002') {
      return res.status(409).json({
        message: 'Ya existe otro cliente con ese RIF/Cédula'
      });
    }
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
  } catch (error: any) {
    if (error?.code === 'P2003') {
      return res.status(409).json({
        message: 'No se puede eliminar: el cliente tiene facturas asociadas'
      });
    }
    res.status(500).json({ message: 'Error al eliminar el cliente', error });
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

    res.status(201).json(nuevoCliente);
  } catch (error: any) {
    if (error?.code === 'P2002') {
      return res.status(409).json({
        message: `Ya existe un cliente registrado con el documento ${error?.meta?.target ?? ''}`.trim()
      });
    }
    res.status(500).json({ message: 'Error al registrar el cliente', error });
  }
};