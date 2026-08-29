import { Request, Response } from 'express';
import { prisma } from '../config/db';
import { AuthRequest } from '../middlewares/auth.middleware';

export const getNotasEntrega = async (_req: Request, res: Response) => {
  try {
    const notas = await prisma.notas_entrega_entrada.findMany({
      include: {
        proveedores: true,
        usuarios: { select: { Usuario_ID: true, Nombre: true } },
        detalle_notas_entrega: { include: { productos: true } }
      }
    });
    return res.json(notas);
  } catch (error) {
    return res.status(500).json({ message: 'Error al obtener notas de entrega', error });
  }
};

export const createNotaEntrega = async (req: AuthRequest, res: Response) => {
  try {
    const { Numero_Nota, Proveedor_ID, detalles } = req.body;
    const Usuario_ID = req.user?.id || req.user?.Usuario_ID || req.body.Usuario_ID || 1;

    if (!Numero_Nota || !Proveedor_ID || !detalles || !Array.isArray(detalles) || detalles.length === 0) {
      return res.status(400).json({ 
        message: 'Numero_Nota, Proveedor_ID y al menos un detalle son obligatorios' 
      });
    }

    const resultado = await prisma.$transaction(async (tx) => {
      let totalCosto = 0;
      for (const item of detalles) {
        totalCosto += Number(item.Cantidad) * Number(item.Costo_Unitario);
      }

      const nuevaNota = await tx.notas_entrega_entrada.create({
        data: {
          Numero_Nota,
          Proveedor_ID: Number(Proveedor_ID),
          Usuario_ID: Number(Usuario_ID),
          Total_Costo: totalCosto,
          Estatus: 'Procesada'
        }
      });

      for (const item of detalles) {
        const subtotal = Number(item.Cantidad) * Number(item.Costo_Unitario);

        await tx.detalle_notas_entrega.create({
          data: {
            Nota_ID: nuevaNota.Nota_ID,
            Producto_ID: Number(item.Producto_ID),
            Cantidad: Number(item.Cantidad),
            Costo_Unitario: Number(item.Costo_Unitario),
            Subtotal_Costo: subtotal
          }
        });

        // Actualizar stock y recalcular el costo promedio ponderado.
        // Costo_Promedio = (stockAnterior * costoAnterior + cantEntrada * costoEntrada)
        //                / (stockAnterior + cantEntrada)
        const productoActual = await tx.productos.findUnique({
          where: { Producto_ID: Number(item.Producto_ID) }
        });

        const stockAnterior = productoActual ? Number(productoActual.Stock_Actual) : 0;
        const costoAnterior = productoActual ? Number(productoActual.Costo_Promedio) : 0;
        const cantidadEntrada = Number(item.Cantidad);
        const costoEntrada = Number(item.Costo_Unitario);
        const nuevoStock = stockAnterior + cantidadEntrada;
        const nuevoCostoPromedio = nuevoStock > 0
          ? (stockAnterior * costoAnterior + cantidadEntrada * costoEntrada) / nuevoStock
          : costoEntrada;

        await tx.productos.update({
          where: { Producto_ID: Number(item.Producto_ID) },
          data: {
            Stock_Actual: nuevoStock,
            Costo_Promedio: nuevoCostoPromedio
          }
        });
      }

      return nuevaNota;
    });

    return res.status(201).json({ message: 'Nota de entrega registrada con éxito', nota: resultado });
  } catch (error: any) {
    return res.status(400).json({ message: 'Error al procesar la entrada de mercancía', error: error.message });
  }
};