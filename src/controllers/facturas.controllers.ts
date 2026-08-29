import { Request, Response } from 'express';
import { prisma } from '../config/db';
import { AuthRequest } from '../middlewares/auth.middleware';

export const getFacturas = async (_req: Request, res: Response) => {
  try {
    const facturas = await prisma.facturas.findMany({
      include: {
        clientes: true,
        usuarios: { select: { Usuario_ID: true, Nombre: true } },
        detalle_facturas: { include: { productos: true } },
        pagos: true
      }
    });
    return res.json(facturas);
  } catch (error) {
    return res.status(500).json({ message: 'Error al obtener las facturas', error });
  }
};

export const getFacturaById = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const factura = await prisma.facturas.findUnique({
      where: { Factura_ID: Number(id) },
      include: {
        clientes: true,
        usuarios: { select: { Usuario_ID: true, Nombre: true } },
        detalle_facturas: { include: { productos: true } },
        pagos: true
      }
    });

    if (!factura) {
      return res.status(404).json({ message: 'Factura no encontrada' });
    }

    return res.json(factura);
  } catch (error) {
    return res.status(500).json({ message: 'Error al obtener la factura', error });
  }
};

export const createFactura = async (req: AuthRequest, res: Response) => {
  // Se acepta 'detalles' o 'Detalles' indiferentemente para ser tolerante con el cliente
  const { Cliente_ID, Numero_Control } = req.body;
  const detalles = req.body.detalles ?? req.body.Detalles;
  const Usuario_ID = req.user?.id || req.user?.Usuario_ID || req.body.Usuario_ID || 1;

  if (!Cliente_ID || !detalles || !Array.isArray(detalles) || detalles.length === 0) {
    return res.status(400).json({
      message: 'Cliente_ID y al menos un detalle son obligatorios'
    });
  }

  try {
    const resultado = await prisma.$transaction(async (tx) => {
      // 1. Validar stock disponible para todos los productos
      for (const item of detalles) {
        const prod = await tx.productos.findUnique({
          where: { Producto_ID: Number(item.Producto_ID) }
        });

        if (!prod || prod.Stock_Actual < Number(item.Cantidad)) {
          throw new Error(`Stock insuficiente para el producto: ${prod?.Nombre || item.Producto_ID}`);
        }
      }

      // 2. Calcular montos
      const subtotal = detalles.reduce(
        (acc: number, item: any) => acc + (Number(item.Cantidad) * Number(item.Precio_Unitario)),
        0
      );
      const totalIva = subtotal * 0.16;
      const totalGeneral = subtotal + totalIva;

      // 3. Crear cabecera y detalles de la factura
      const numeroControl =
        Numero_Control || `FV-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}`;

      const nuevaFactura = await tx.facturas.create({
        data: {
          Cliente_ID: Number(Cliente_ID),
          Usuario_ID: Number(Usuario_ID),
          Numero_Control: numeroControl,
          Subtotal: subtotal,
          Total_IVA: totalIva,
          Total_General: totalGeneral,
          Estatus: 'Pagada',
          detalle_facturas: {
            create: detalles.map((d: any) => ({
              Producto_ID: Number(d.Producto_ID),
              Cantidad: Number(d.Cantidad),
              Precio_Unitario: Number(d.Precio_Unitario),
              Subtotal: Number(d.Cantidad) * Number(d.Precio_Unitario)
            }))
          }
        }
      });

      // 4. Descontar el stock de los productos vendidos
      for (const item of detalles) {
        await tx.productos.update({
          where: { Producto_ID: Number(item.Producto_ID) },
          data: { Stock_Actual: { decrement: Number(item.Cantidad) } }
        });
      }

      return nuevaFactura;
    });

    return res.status(201).json({ message: 'Factura registrada exitosamente', factura: resultado });
  } catch (error: any) {
    return res.status(400).json({ error: error.message || 'Error al procesar la venta' });
  }
};