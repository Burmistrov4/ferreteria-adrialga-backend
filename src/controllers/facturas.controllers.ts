import { Response } from 'express';
import { prisma } from '../config/db';
import { AuthRequest } from '../middlewares/auth.middleware';

export const getFacturas = async (_req: AuthRequest, res: Response) => {
  try {
    const facturas = await prisma.facturas.findMany({
      include: {
        clientes: true,
        usuarios: { select: { Usuario_ID: true, Nombre: true } },
        detalle_facturas: { include: { productos: true } }
      }
    });
    res.json(facturas);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener facturas', error });
  }
};

export const createFactura = async (req: AuthRequest, res: Response) => {
  try {
    const { Numero_Factura, Cliente_ID, detalles } = req.body;
    const Usuario_ID = req.user?.id || req.user?.Usuario_ID || 1;

    if (!Numero_Factura || !Cliente_ID || !detalles || !Array.isArray(detalles) || detalles.length === 0) {
      return res.status(400).json({ 
        message: 'Numero_Factura, Cliente_ID y al menos un detalle son obligatorios' 
      });
    }

    const resultado = await prisma.$transaction(async (tx) => {
      // 1. Validar stock suficiente para todos los productos
      for (const item of detalles) {
        const producto = await tx.productos.findUnique({
          where: { Producto_ID: Number(item.Producto_ID) }
        });

        if (!producto || producto.Stock_Actual < item.Cantidad) {
          throw new Error(`Stock insuficiente para el producto: ${producto?.Nombre || item.Producto_ID}`);
        }
      }

      // 2. Calcular total de la venta
      let totalVenta = 0;
      for (const item of detalles) {
        totalVenta += Number(item.Cantidad) * Number(item.Precio_Unitario);
      }

      // 3. Crear cabecera de la factura
      const nuevaFactura = await tx.facturas.create({
        data: {
          Numero_Factura,
          Cliente_ID: Number(Cliente_ID),
          Usuario_ID: Number(Usuario_ID),
          Total_Venta: totalVenta,
          Estatus: 'Pagada'
        }
      });

      // 4. Registrar detalles y descontar del Stock_Actual
      for (const item of detalles) {
        const subtotal = Number(item.Cantidad) * Number(item.Precio_Unitario);

        await tx.detalle_facturas.create({
          data: {
            Factura_ID: nuevaFactura.Factura_ID,
            Producto_ID: Number(item.Producto_ID),
            Cantidad: Number(item.Cantidad),
            Precio_Unitario: item.Precio_Unitario,
            Subtotal: subtotal
          }
        });

        await tx.productos.update({
          where: { Producto_ID: Number(item.Producto_ID) },
          data: {
            Stock_Actual: { decrement: Number(item.Cantidad) }
          }
        });
      }

      return nuevaFactura;
    });

    res.status(201).json({ message: 'Factura procesada con éxito', factura: resultado });
  } catch (error: any) {
    console.error('Error al procesar la factura:', error);
    res.status(500).json({ message: error.message || 'Error al procesar la venta' });
  }
};