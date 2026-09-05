import { Request, Response } from 'express';
import { prisma } from '../config/db';
import { AuthRequest } from '../middlewares/auth.middleware';
import { toD4, addD4, mulD4, divD4, aDecimal } from '../utils/dinero';
import { asegurarCajaPrincipal } from '../utils/caja';

// ── Proveedor por defecto para compras informales/locales ───────────────────
const PROVEEDOR_INFORMAL_RIF = 'J-000000000';
const PROVEEDOR_INFORMAL_NOMBRE = 'PROVEEDOR GENERAL / INFORMAL';

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
    // Forma de pago de la compra: 'Contado' (default) descuenta caja;
    // 'Credito' registra la obligación en cuentas_por_pagar sin tocar caja.
    const Forma_Pago: 'Contado' | 'Credito' =
      req.body.Forma_Pago === 'Credito' ? 'Credito' : 'Contado';
    const Usuario_ID = req.user?.usuarioId;
    if (!Usuario_ID) {
      return res.status(401).json({ message: 'Token sin identificación de usuario' });
    }

    if (!Numero_Nota || !detalles || !Array.isArray(detalles) || detalles.length === 0) {
      return res.status(400).json({
        message: 'Numero_Nota y al menos un detalle son obligatorios'
      });
    }

    const resultado = await prisma.$transaction(async (tx) => {
      // ── Fallback de proveedor informal ──────────────────────────────────
      // Si no viene Proveedor_ID, se busca (o crea) el proveedor genérico
      // "PROVEEDOR GENERAL / INFORMAL" para mantener la integridad referencial.
      let proveedorId = Number(Proveedor_ID);
      if (!proveedorId) {
        const informal = await tx.proveedores.upsert({
          where: { RIF_Cedula: PROVEEDOR_INFORMAL_RIF },
          update: {},
          create: {
            RIF_Cedula: PROVEEDOR_INFORMAL_RIF,
            Razon_Social: PROVEEDOR_INFORMAL_NOMBRE
          }
        });
        proveedorId = informal.Proveedor_ID;
      }

      // ── Validación explícita de productos (fail-fast, antes de escribir) ──
      const productosVigentes = new Map<
        number,
        { stock: number; costoD4: bigint }
      >();
      for (const item of detalles) {
        const producto = await tx.productos.findUnique({
          where: { Producto_ID: Number(item.Producto_ID) }
        });
        if (!producto || !producto.Activo) {
          throw new Error(
            `VALIDACION:El producto con ID ${item.Producto_ID} no existe o está inactivo`
          );
        }
        productosVigentes.set(Number(item.Producto_ID), {
          stock: Number(producto.Stock_Actual),
          costoD4: toD4(producto.Costo_Promedio)
        });
      }

      // ── Costos normalizados (el costo de compra es OPCIONAL) ────────────
      // Si el ítem no trae costo (> 0), el detalle se registra con el
      // Costo_Promedio vigente y el CPP NO se recalcula (evita diluir el
      // promedio con un valor que no proviene de una compra real).
      const normalizados = detalles.map((item: any) => {
        const productoId = Number(item.Producto_ID);
        const vigente = productosVigentes.get(productoId)!;
        const costoEntrada = toD4(item.Costo_Unitario);
        const cantidad = Number(item.Cantidad);

        if (costoEntrada > 0n) {
          return {
            productoId,
            cantidad,
            cantidadD4: toD4(cantidad),
            costoD4: costoEntrada,
            recalculaCpp: true
          };
        }
        return {
          productoId,
          cantidad,
          cantidadD4: toD4(cantidad),
          costoD4: vigente.costoD4,
          recalculaCpp: false
        };
      });

      // Total de la nota a 4 decimales exactos (sin floats)
      let totalCosto = 0n;
      for (const d of normalizados) {
        totalCosto = addD4(totalCosto, mulD4(d.cantidadD4, d.costoD4));
      }

      const nuevaNota = await tx.notas_entrega_entrada.create({
        data: {
          Numero_Nota,
          Proveedor_ID: proveedorId,
          Usuario_ID: Number(Usuario_ID),
          Total_Costo: aDecimal(totalCosto),
          Estatus: 'Procesada'
        }
      });

      for (const d of normalizados) {
        const subtotal = mulD4(d.cantidadD4, d.costoD4);

        await tx.detalle_notas_entrega.create({
          data: {
            Nota_ID: nuevaNota.Nota_ID,
            Producto_ID: d.productoId,
            Cantidad: d.cantidad,
            Costo_Unitario: aDecimal(d.costoD4),
            Subtotal_Costo: aDecimal(subtotal)
          }
        });

        const vigente = productosVigentes.get(d.productoId)!;
        const nuevoStock = vigente.stock + d.cantidad;

        // ── Costo Promedio Ponderado (CPP) con aritmética exacta ─────────
        // CPP_nuevo = ((Stock_actual × CPP_actual) + (Cant_entrante × Costo))
        //             / (Stock_actual + Cant_entrante)
        // Solo se recalcula si el ítem trajo costo de compra explícito.
        // Si Stock_actual = 0 → CPP_nuevo = Costo de compra directamente.
        let cppNuevo = vigente.costoD4;
        if (d.recalculaCpp) {
          cppNuevo =
            vigente.stock > 0
              ? divD4(
                  addD4(
                    mulD4(toD4(vigente.stock), vigente.costoD4),
                    mulD4(d.cantidadD4, d.costoD4)
                  ),
                  toD4(nuevoStock)
                )
              : d.costoD4;
        }

        await tx.productos.update({
          where: { Producto_ID: d.productoId },
          data: {
            Stock_Actual: nuevoStock,
            Costo_Promedio: aDecimal(cppNuevo)
          }
        });
      }

      // ── Impacto en Tesorería (dentro de la misma transacción) ──────────
      // Contado → EGRESO en caja por el costo total de la compra.
      // Crédito → obligación en cuentas_por_pagar (caja sin cambios).
      if (Forma_Pago === 'Contado') {
        const caja = await asegurarCajaPrincipal(tx);
        await tx.movimientos_caja.create({
          data: {
            Caja_ID: caja.Caja_ID,
            Tipo: 'EGRESO',
            Concepto: `Compra — Nota de entrega #${nuevaNota.Nota_ID} (${Numero_Nota})`,
            Metodo_Pago: 'Efectivo USD',
            Monto_USD: aDecimal(totalCosto),
            Origen_Tipo: 'nota',
            Origen_ID: nuevaNota.Nota_ID
          }
        });
        await tx.caja.update({
          where: { Caja_ID: caja.Caja_ID },
          data: { Saldo_Actual: { decrement: aDecimal(totalCosto) } }
        });
      } else {
        await tx.cuentas_por_pagar.create({
          data: {
            Proveedor_ID: proveedorId,
            Nota_ID: nuevaNota.Nota_ID,
            Monto_Total: aDecimal(totalCosto),
            Monto_Pagado: 0,
            Saldo: aDecimal(totalCosto),
            Estatus: 'Pendiente'
          }
        });
      }

      return nuevaNota;
    });

    return res.status(201).json({ message: 'Nota de entrega registrada con éxito', nota: resultado });
  } catch (error: any) {
    // Errores de validación de negocio lanzados dentro de la transacción
    if (typeof error?.message === 'string' && error.message.startsWith('VALIDACION:')) {
      return res.status(400).json({ message: error.message.replace('VALIDACION:', '') });
    }
    return res.status(400).json({ message: 'Error al procesar la entrada de mercancía', error: error.message });
  }
};