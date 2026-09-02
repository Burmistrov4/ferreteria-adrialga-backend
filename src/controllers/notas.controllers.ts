import { Request, Response } from 'express';
import { prisma } from '../config/db';
import { AuthRequest } from '../middlewares/auth.middleware';
import { toD4, addD4, mulD4, divD4, aDecimal } from '../utils/dinero';

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
    const Usuario_ID = req.user?.usuarioId;
    if (!Usuario_ID) {
      return res.status(401).json({ message: 'Token sin identificación de usuario' });
    }

    if (!Numero_Nota || !Proveedor_ID || !detalles || !Array.isArray(detalles) || detalles.length === 0) {
      return res.status(400).json({ 
        message: 'Numero_Nota, Proveedor_ID y al menos un detalle son obligatorios' 
      });
    }

    const resultado = await prisma.$transaction(async (tx) => {
      // Total de la nota a 4 decimales exactos (sin floats)
      let totalCosto = 0n;
      for (const item of detalles) {
        totalCosto = addD4(
          totalCosto,
          mulD4(toD4(item.Cantidad), toD4(item.Costo_Unitario))
        );
      }

      const nuevaNota = await tx.notas_entrega_entrada.create({
        data: {
          Numero_Nota,
          Proveedor_ID: Number(Proveedor_ID),
          Usuario_ID: Number(Usuario_ID),
          Total_Costo: aDecimal(totalCosto),
          Estatus: 'Procesada'
        }
      });

      for (const item of detalles) {
        const cantidadD4 = toD4(item.Cantidad);
        const costoD4 = toD4(item.Costo_Unitario);
        const subtotal = mulD4(cantidadD4, costoD4);

        await tx.detalle_notas_entrega.create({
          data: {
            Nota_ID: nuevaNota.Nota_ID,
            Producto_ID: Number(item.Producto_ID),
            Cantidad: Number(item.Cantidad),
            Costo_Unitario: aDecimal(costoD4),
            Subtotal_Costo: aDecimal(subtotal)
          }
        });

        // ── Costo Promedio Ponderado (CPP) con aritmética exacta ─────────
        // CPP_nuevo = ((Stock_actual × CPP_actual) + (Cant_entrante × Precio_compra))
        //             / (Stock_actual + Cant_entrante)
        // Si Stock_actual = 0 → CPP_nuevo = Precio_compra directamente.
        const productoActual = await tx.productos.findUnique({
          where: { Producto_ID: Number(item.Producto_ID) }
        });

        const stockAnterior = productoActual ? Number(productoActual.Stock_Actual) : 0;
        const cppActual = productoActual ? toD4(productoActual.Costo_Promedio) : 0n;
        const nuevoStock = stockAnterior + Number(item.Cantidad);

        const cppNuevo =
          stockAnterior > 0
            ? divD4(
                addD4(mulD4(toD4(stockAnterior), cppActual), mulD4(cantidadD4, costoD4)),
                toD4(nuevoStock)
              )
            : costoD4;

        await tx.productos.update({
          where: { Producto_ID: Number(item.Producto_ID) },
          data: {
            Stock_Actual: nuevoStock,
            Costo_Promedio: aDecimal(cppNuevo)
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