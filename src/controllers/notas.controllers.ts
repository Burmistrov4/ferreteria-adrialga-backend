import { Request, Response } from 'express';
import { prisma } from '../config/db';
import { AuthRequest } from '../middlewares/auth.middleware';
import { toD4, addD4, mulD4, divD4, aDecimal } from '../utils/dinero';
import { exigirCajaAbierta } from '../utils/caja';

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
        { stock: number; costoD4: bigint; margen: number; varianteId: number | null }
      >();
      for (const item of detalles) {
        const producto = await tx.productos.findUnique({
          where: { Producto_ID: Number(item.Producto_ID) },
          include: { categorias: { select: { Margen_Sugerido: true } } },
        });
        if (!producto || !producto.Activo) {
          throw new Error(
            `VALIDACION:El producto con ID ${item.Producto_ID} no existe o está inactivo`
          );
        }
        // Margen efectivo del producto: propio o heredado de la categoría.
        const margenProp = Number(producto.Margen_Ganancia);
        const margenCat = producto.categorias?.Margen_Sugerido != null
          ? Number(producto.categorias.Margen_Sugerido)
          : 0;
        productosVigentes.set(Number(item.Producto_ID), {
          stock: Number(producto.Stock_Actual),
          costoD4: toD4(producto.Costo_Promedio),
          margen: margenProp > 0 ? margenProp : margenCat,
          varianteId: item.Variante_ID != null ? Number(item.Variante_ID) : null,
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
            recalculaCpp: true,
            varianteId: vigente.varianteId
          };
        }
        return {
          productoId,
          cantidad,
          cantidadD4: toD4(cantidad),
          costoD4: vigente.costoD4,
          recalculaCpp: false,
          varianteId: vigente.varianteId
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
          // CPP = ((stockPrev × cppPrev) + (qty × costoCompra)) / (stockPrev + qty).
          // Fallback stock-cero: stockPrev + qty == cantidad → costo directo,
          // NUNCA divide entre cero (condición cubierta por vigente.stock >= 0).
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

        // Recálculo de precio con el margen del producto tras el nuevo CPP
        // (margen heredado por cascada; 0 → se conserva el precio actual).
        let precioNuevo: number | undefined;
        if (d.recalculaCpp && vigente.margen > 0) {
          const base = Number(cppNuevo) / 10000;
          precioNuevo = Number((base * (1 + vigente.margen / 100)).toFixed(6));
        }

        await tx.productos.update({
          where: { Producto_ID: d.productoId },
          data: {
            Stock_Actual: nuevoStock,
            Costo_Promedio: aDecimal(cppNuevo),
            // Costo_Ultimo refleja la última compra con costo explícito —
            // base del precio sugerido (Precio = Costo*(1+Margen%)) en la UI.
            ...(d.recalculaCpp ? { Costo_Ultimo: aDecimal(d.costoD4) } : {}),
            ...(precioNuevo !== undefined ? { Precio_Venta: precioNuevo } : {}),
          }
        });

        // ── Variante a nivel matriz (si la nota la especifica) ─────────────
        // Suma stock a la variante, actualiza su costo y, si el producto o su
        // variante tienen margen, recalcula su precio con la cascada
        // Variante → Producto (la base vigente.margen ya cubre la categoría).
        if (d.varianteId != null) {
          const variant = await tx.producto_variantes.findUnique({
            where: { Variante_ID: d.varianteId },
          });
          if (variant && variant.Producto_ID === d.productoId) {
            const mVar = variant.Margen_Ganancia != null
              ? Number(variant.Margen_Ganancia)
              : null;
            const margenEfectivo = mVar ?? vigente.margen;
            const nuevoStockVar = variant.Stock_Actual + d.cantidad;
            const nuevoCostoVar =
              d.recalculaCpp ? Number(d.costoD4) / 10000 : Number(variant.Costo_Unitario);
            const nuevoPrecioVar =
              d.recalculaCpp && margenEfectivo > 0
                ? Number((nuevoCostoVar * (1 + margenEfectivo / 100)).toFixed(6))
                : undefined;
            await tx.producto_variantes.update({
              where: { Variante_ID: d.varianteId },
              data: {
                Stock_Actual: nuevoStockVar,
                ...(d.recalculaCpp ? { Costo_Unitario: nuevoCostoVar } : {}),
                ...(nuevoPrecioVar !== undefined ? { Precio_Venta: nuevoPrecioVar } : {}),
              },
            });
          }
        }
      }

      // ── Impacto en Tesorería (dentro de la misma transacción) ──────────
      // Contado → EGRESO en caja por el costo total de la compra.
      // Crédito → obligación en cuentas_por_pagar (caja sin cambios).
      if (Forma_Pago === 'Contado') {
        // Regla de negocio (arqueo): compras en contado exigen caja abierta.
        const caja = await exigirCajaAbierta(tx);

        // ── REGLA ANTI-DÉFICIT (Fondo de maniobra) ────────────────────────
        // Bloquea la compra a contado si el costo total supera el saldo
        // disponible en caja: nunca se permite dejar la gaveta en negativo.
        // El cajero debe solicitar un Ingreso de Caja al supervisor (PIN)
        // o registrar la operación a Crédito.
        const saldoCajaD4 = toD4(caja.Saldo_Actual);
        if (totalCosto > saldoCajaD4) {
          throw new Error(
            `SALDO_INSUFICIENTE:El costo de la compra ($` +
            `${aDecimal(totalCosto)}) excede el saldo disponible en caja ` +
            `($${aDecimal(saldoCajaD4)}). Registre la operación a Crédito o ` +
            `solicite un Ingreso de Caja al supervisor.`
          );
        }

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
    // Fondo de maniobra insuficiente → 400 con tipo para que el cajero
    // defina entre Crédito o Ingreso de Caja por supervisor.
    if (typeof error?.message === 'string' && error.message.startsWith('SALDO_INSUFICIENTE:')) {
      return res.status(422).json({
        error: error.message.replace('SALDO_INSUFICIENTE:', ''),
        tipo: 'SALDO_INSUFICIENTE'
      });
    }
    // Caja cerrada → 409 para que el cliente bloquee la entrada de mercancía
    const status = typeof error?.status === 'number' ? error.status : 400;
    return res.status(status).json({
      message: status === 409 ? error.message : 'Error al procesar la entrada de mercancía',
      ...(status === 409 ? { tipo: 'CAJA_CERRADA' } : {}),
      ...(status === 400 && !error.message.startsWith('VALIDACION:') ? { error: error.message } : {})
    });
  }
};