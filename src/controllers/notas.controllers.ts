import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { AuthRequest } from '../middlewares/auth.middleware';
import { toD4, addD4, subD4, mulD4, divD4, aDecimal } from '../utils/dinero';
import { exigirCajaAbierta, reintentarEnDeadlock } from '../utils/caja';
import { responderErrorPrisma } from '../utils/errores';
import { IoStore } from '../utils/socket';

interface FilaProductoCompra {
  Producto_ID: number;
  Stock_Actual: number;
  Costo_Promedio: Prisma.Decimal;
  Margen_Ganancia: Prisma.Decimal;
  Margen_Categoria: Prisma.Decimal | null;
  Activo: boolean;
}

interface FilaVarianteCompra {
  Variante_ID: number;
  Producto_ID: number;
  Stock_Actual: number;
  Costo_Unitario: Prisma.Decimal;
  Margen_Ganancia: Prisma.Decimal | null;
  Activo: boolean;
}

// ── Proveedor por defecto para compras informales/locales ───────────────────
const PROVEEDOR_INFORMAL_RIF = 'J-000000000';
const PROVEEDOR_INFORMAL_NOMBRE = 'PROVEEDOR GENERAL / INFORMAL';

export const getNotasEntrega = async (_req: Request, res: Response) => {
  try {
    const notas = await prisma.notas_entrega_entrada.findMany({
      include: {
        proveedores: true,
        usuarios: { select: { Usuario_ID: true, Nombre: true } },
        detalle_notas_entrega: {
          include: {
            productos: true,
            // A-016: exponer la variante recibida en la lectura de notas.
            producto_variantes: true,
          },
        }
      }
    });
    return res.json(notas);
  } catch (error) {
    return responderErrorPrisma(res, error, {
      recurso: 'nota de entrega',
      contexto: 'obtener las',
    });
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

    const resultado = await reintentarEnDeadlock(
      prisma,
      { timeout: 30000, maxWait: 20000 },
      async (tx) => {
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
      // Bloqueo pesimista: una compra concurrente no puede leer un stock viejo
      // y sobrescribir el incremento de otra transacción.
      const productoIds = Array.from(
        new Set(detalles.map((item) => Number(item.Producto_ID))),
      ).sort((a, b) => a - b);
      const varianteIds = Array.from(
        new Set(
          detalles
            .map((item) => item.Variante_ID)
            .filter((id): id is number => id != null)
            .map(Number),
        ),
      ).sort((a, b) => a - b);

      const filasProductos = productoIds.length
        ? await tx.$queryRaw<FilaProductoCompra[]>(Prisma.sql`
            SELECT p.Producto_ID, p.Stock_Actual, p.Costo_Promedio,
                   p.Margen_Ganancia, c.Margen_Sugerido AS Margen_Categoria, p.Activo
            FROM productos p
            LEFT JOIN categorias c ON c.Categoria_ID = p.Categoria_ID
            WHERE p.Producto_ID IN (${Prisma.join(productoIds)})
            FOR UPDATE`)
        : [];
      const filasVariantes = varianteIds.length
        ? await tx.$queryRaw<FilaVarianteCompra[]>(Prisma.sql`
            SELECT Variante_ID, Producto_ID, Stock_Actual, Costo_Unitario, Margen_Ganancia, Activo
            FROM producto_variantes
            WHERE Variante_ID IN (${Prisma.join(varianteIds)})
            FOR UPDATE`)
        : [];

      const productosVigentes = new Map(
        filasProductos.map((p) => [p.Producto_ID, {
          stock: Number(p.Stock_Actual),
          costoD4: toD4(p.Costo_Promedio),
          margen: Number(p.Margen_Ganancia) > 0
            ? Number(p.Margen_Ganancia)
            : Number(p.Margen_Categoria ?? 0),
          activo: p.Activo,
        }]),
      );
      const variantesVigentes = new Map(
        filasVariantes.map((v) => [v.Variante_ID, v]),
      );

      for (const item of detalles) {
        const producto = productosVigentes.get(Number(item.Producto_ID));
        if (!producto || !producto.activo) {
          throw new Error(
            `VALIDACION:El producto con ID ${item.Producto_ID} no existe o está inactivo`,
          );
        }
        const cantidad = Number(item.Cantidad);
        if (!Number.isInteger(cantidad) || cantidad <= 0) {
          throw new Error(`VALIDACION:La cantidad del producto ${item.Producto_ID} debe ser un entero mayor que cero`);
        }
        if (item.Variante_ID != null) {
          const variante = variantesVigentes.get(Number(item.Variante_ID));
          if (!variante || !variante.Activo || variante.Producto_ID !== Number(item.Producto_ID)) {
            throw new Error(
              `VALIDACION:La variante ${item.Variante_ID} no pertenece al producto ${item.Producto_ID}`,
            );
          }
        }
      }

      // ── Costos normalizados (el costo de compra es OPCIONAL) ────────────
      // Si el ítem no trae costo (> 0), el detalle se registra con el
      // Costo_Promedio vigente y el CPP NO se recalcula (evita diluir el
      // promedio con un valor que no proviene de una compra real).
      const normalizados = detalles.map((item: {
        Producto_ID: number;
        Cantidad: number;
        Costo_Unitario?: number;
        Variante_ID?: number | null;
      }) => {
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
            varianteId: item.Variante_ID != null ? Number(item.Variante_ID) : null
          };
        }
        return {
          productoId,
          cantidad,
          cantidadD4: toD4(cantidad),
          costoD4: vigente.costoD4,
          recalculaCpp: false,
          varianteId: item.Variante_ID != null ? Number(item.Variante_ID) : null
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
            // A-016: conservar la trazabilidad de la variante en el histórico
            // de compras (la variante ya se actualizaba, pero no se persistía).
            Variante_ID: d.varianteId,
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
        productosVigentes.set(d.productoId, {
          stock: nuevoStock,
          costoD4: cppNuevo,
          margen: vigente.margen,
          activo: vigente.activo,
        });

        // ── Variante a nivel matriz (si la nota la especifica) ─────────────
        // Suma stock a la variante, actualiza su costo y, si el producto o su
        // variante tienen margen, recalcula su precio con la cascada
        // Variante → Producto (la base vigente.margen ya cubre la categoría).
        if (d.varianteId != null) {
          const variant = variantesVigentes.get(d.varianteId);
          if (variant && variant.Producto_ID === d.productoId) {
            const nuevoStockVar = variant.Stock_Actual + d.cantidad;
            const nuevoCostoVar =
              d.recalculaCpp ? Number(d.costoD4) / 10000 : Number(variant.Costo_Unitario);
            const margenEfectivo = variant.Margen_Ganancia != null
              ? Number(variant.Margen_Ganancia)
              : vigente.margen;
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
            variant.Stock_Actual = nuevoStockVar;
            if (d.recalculaCpp) variant.Costo_Unitario = new Prisma.Decimal(nuevoCostoVar);
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

    IoStore.emitDbUpdate('inventario', `Entrada de mercancía registrada: Nota #${resultado.Nota_ID}`, { notaId: resultado.Nota_ID });
    IoStore.emitDbUpdate('caja', `Movimiento de caja por entrada de mercancía: Nota #${resultado.Nota_ID}`, { notaId: resultado.Nota_ID });
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

/**
 * reverseNotaEntrega — A-017: anulación/reversa de una nota de entrada.
 *
 * Diseño (ver doc/01_HALLAZGOS_Y_RIESGOS.md A-017 y REGISTRO_DECISIONES ADR-008):
 *  - NO destructiva: la nota original se conserva y solo se marca Estatus='Anulada'
 *    con actor (Anulada_Por), fecha y motivo.
 *  - Autorización: solo ADMIN o SUPERVISOR (operación financiera sensible).
 *  - Idempotente: una nota ya 'Anulada' → 409 YA_ANULADA.
 *  - Transaccional y serializada: bloqueo FOR UPDATE sobre productos/variantes;
 *    reintenta ante deadlock (igual que createNotaEntrega).
 *  - Casos AMBIGUOS se BLOQUEAN con código explícito en vez de adivinar:
 *      · PARCIAL_CONSUMIDO → 409: parte de la mercancía ya se vendió/consumió
 *        (reversa parcial requiere decisión de negocio).
 *      · CXP_CON_PAGOS → 409: la cuenta por pagar tiene pagos aplicados; reversar
 *        primero el pago.
 *  - Caso limpio (implementado y validado en QA):
 *      · Crédito + CxP Pendiente (Monto_Pagado=0) → se anula la CxP (no borra).
 *      · Contado → requiere caja abierta; crea INGRESO y repone el saldo.
 *      · Stock de producto y variante se revierte (floored a 0).
 *      · CMP del producto se revierte con el inverso ponderado del promedio.
 */
export const reverseNotaEntrega = async (req: AuthRequest, res: Response) => {
  try {
    const Usuario_ID = req.user?.usuarioId;
    const rol = (req.user?.rol ?? '').toString().toUpperCase();
    if (!Usuario_ID) {
      return res.status(401).json({ message: 'Token sin identificación de usuario' });
    }
    // Solo ADMIN o SUPERVISOR pueden anular una nota de entrada.
    if (rol !== 'ADMIN' && rol !== 'SUPERVISOR') {
      return res.status(403).json({
        message: 'No autorizado para anular notas de entrada',
        tipo: 'PERMISO_INSUFICIENTE'
      });
    }

    const notaId = Number(req.params.id ?? req.body.Nota_ID);
    if (!Number.isInteger(notaId) || notaId <= 0) {
      return res.status(400).json({ message: 'Nota_ID inválido' });
    }
    const motivo = (req.body?.motivo ?? '').toString().slice(0, 200);

    const resultado = await reintentarEnDeadlock(
      prisma,
      { timeout: 30000, maxWait: 20000 },
      async (tx) => {
        const nota = await tx.notas_entrega_entrada.findUnique({
          where: { Nota_ID: notaId },
          include: {
            detalle_notas_entrega: { include: { productos: true, producto_variantes: true } },
            cuentas_por_pagar: true
          }
        });
        if (!nota) {
          const e: any = new Error('NOTA_NO_ENCONTRADA');
          e.status = 404;
          throw e;
        }
        if (nota.Estatus === 'Anulada') {
          const e: any = new Error('YA_ANULADA');
          e.status = 409;
          throw e;
        }
        if (nota.Estatus !== 'Procesada') {
          const e: any = new Error(`ESTADO_NO_ANULABLE:${nota.Estatus}`);
          e.status = 400;
          throw e;
        }

        const cxp = nota.cuentas_por_pagar;
        const detalles = nota.detalle_notas_entrega;

        // ── Lock determinista de productos/variantes ───────────────────────
        const productoIds = Array.from(new Set(detalles.map((d) => d.Producto_ID))).sort((a, b) => a - b);
        const varianteIds = Array.from(
          new Set(detalles.map((d) => d.Variante_ID).filter((x): x is number => x != null))
        ).sort((a, b) => a - b);

        const filasProductos = productoIds.length
          ? await tx.$queryRaw<FilaProductoCompra[]>(Prisma.sql`
              SELECT p.Producto_ID, p.Stock_Actual, p.Costo_Promedio,
                     p.Margen_Ganancia, c.Margen_Sugerido AS Margen_Categoria, p.Activo
              FROM productos p
              LEFT JOIN categorias c ON c.Categoria_ID = p.Categoria_ID
              WHERE p.Producto_ID IN (${Prisma.join(productoIds)})
              FOR UPDATE`)
          : [];
        const filasVariantes = varianteIds.length
          ? await tx.$queryRaw<FilaVarianteCompra[]>(Prisma.sql`
              SELECT Variante_ID, Producto_ID, Stock_Actual, Costo_Unitario, Margen_Ganancia, Activo
              FROM producto_variantes
              WHERE Variante_ID IN (${Prisma.join(varianteIds)})
              FOR UPDATE`)
          : [];

        // ── Chequeo de mercancía aún disponible (no parcialmente vendida) ──
        const recibidoProd = new Map<number, number>();
        const recibidoVar = new Map<number, number>();
        for (const d of detalles) {
          recibidoProd.set(d.Producto_ID, (recibidoProd.get(d.Producto_ID) ?? 0) + Number(d.Cantidad));
          if (d.Variante_ID != null) {
            recibidoVar.set(d.Variante_ID, (recibidoVar.get(d.Variante_ID) ?? 0) + Number(d.Cantidad));
          }
        }
        const stockProd = new Map(filasProductos.map((p) => [p.Producto_ID, Number(p.Stock_Actual)]));
        const stockVar = new Map(filasVariantes.map((v) => [v.Variante_ID, Number(v.Stock_Actual)]));
        for (const [pid, rec] of recibidoProd) {
          if ((stockProd.get(pid) ?? 0) < rec) {
            const e: any = new Error(`PARCIAL_CONSUMIDO:producto ${pid} stock=${stockProd.get(pid)} recibido=${rec}`);
            e.status = 409;
            throw e;
          }
        }
        for (const [vid, rec] of recibidoVar) {
          if ((stockVar.get(vid) ?? 0) < rec) {
            const e: any = new Error(`PARCIAL_CONSUMIDO:variante ${vid} stock=${stockVar.get(vid)} recibido=${rec}`);
            e.status = 409;
            throw e;
          }
        }

        // ── CxP (Crédito) o recuperación de caja (Contado) ─────────────────
        if (cxp) {
          if (Number(cxp.Monto_Pagado) > 0) {
            const e: any = new Error(`CXP_CON_PAGOS:Monto_Pagado=${cxp.Monto_Pagado}`);
            e.status = 409;
            throw e;
          }
          await tx.cuentas_por_pagar.update({
            where: { CxP_ID: cxp.CxP_ID },
            data: { Estatus: 'Anulada', Saldo: 0 }
          });
        } else {
          const caja = await exigirCajaAbierta(tx);
          await tx.movimientos_caja.create({
            data: {
              Caja_ID: caja.Caja_ID,
              Tipo: 'INGRESO',
              Concepto: `Anulación de nota de entrada #${nota.Nota_ID} (${nota.Numero_Nota})`,
              Metodo_Pago: 'Efectivo USD',
              Monto_USD: nota.Total_Costo,
              Origen_Tipo: 'nota',
              Origen_ID: nota.Nota_ID
            }
          });
          await tx.caja.update({
            where: { Caja_ID: caja.Caja_ID },
            data: { Saldo_Actual: { increment: nota.Total_Costo } }
          });
        }

        // ── Reversión de stock y CMP (inverso ponderado del promedio) ──────
        const mapaProd = new Map(filasProductos.map((p) => [p.Producto_ID, p]));
        for (const d of detalles) {
          const fila = mapaProd.get(d.Producto_ID)!;
          const stockNow = Number(fila.Stock_Actual);
          const qty = Number(d.Cantidad);
          const nuevoStock = stockNow - qty; // >=0 por el chequeo previo

          const costoDetalleD4 = toD4(d.Costo_Unitario);
          const cppNowD4 = toD4(fila.Costo_Promedio);
          let cppNuevoD4 = cppNowD4;
          if (costoDetalleD4 > 0n) {
            const stockPrev = nuevoStock;
            if (stockPrev > 0) {
              const numerador = subD4(
                mulD4(toD4(stockNow), cppNowD4),
                mulD4(toD4(qty), costoDetalleD4)
              );
              let cpp = divD4(numerador, toD4(stockPrev));
              cpp = cpp < 0n ? 0n : cpp;
              cppNuevoD4 = cpp;
            } else {
              cppNuevoD4 = 0n;
            }
          }

          await tx.productos.update({
            where: { Producto_ID: d.Producto_ID },
            data: {
              Stock_Actual: nuevoStock,
              ...(costoDetalleD4 > 0n ? { Costo_Promedio: aDecimal(cppNuevoD4) } : {})
            }
          });
          // Mantener el objeto en memoria coherente para líneas siguientes.
          fila.Stock_Actual = nuevoStock;
          fila.Costo_Promedio = aDecimal(cppNuevoD4) as unknown as Prisma.Decimal;

          // Variante: reversión de stock; el costo de variante queda igual salvo
          // que, si queda en 0, se resetea a 0 (limitación documentada A-017).
          if (d.Variante_ID != null) {
            const filaV = filasVariantes.find((v) => v.Variante_ID === d.Variante_ID);
            if (filaV && filaV.Producto_ID === d.Producto_ID) {
              const nuevoStockVar = Number(filaV.Stock_Actual) - qty;
              await tx.producto_variantes.update({
                where: { Variante_ID: d.Variante_ID },
                data: {
                  Stock_Actual: nuevoStockVar,
                  ...(nuevoStockVar <= 0 ? { Costo_Unitario: 0 } : {})
                }
              });
              filaV.Stock_Actual = nuevoStockVar;
            }
          }
        }

        // ── Marcar nota como anulada (preservar historial) ──────────────────
        const notaAnulada = await tx.notas_entrega_entrada.update({
          where: { Nota_ID: nota.Nota_ID },
          data: {
            Estatus: 'Anulada',
            Anulada_Por: Number(Usuario_ID),
            Fecha_Anulacion: new Date(),
            Motivo_Anulacion: motivo || 'Anulación de nota de entrada'
          }
        });

        return { nota: notaAnulada, formaPago: cxp ? 'Credito' : 'Contado' };
      }
    );

    IoStore.emitDbUpdate('inventario', `Nota de entrada #${resultado.nota.Nota_ID} anulada`, { notaId: resultado.nota.Nota_ID });
    IoStore.emitDbUpdate('caja', `Reversa de nota de entrada #${resultado.nota.Nota_ID} (${resultado.formaPago})`, { notaId: resultado.nota.Nota_ID });
    return res.status(200).json({
      message: 'Nota de entrada anulada correctamente',
      nota: resultado.nota,
      formaPago: resultado.formaPago
    });
  } catch (error: any) {
    if (typeof error?.status === 'number') {
      const tipo = error.message.startsWith('NOTA_NO_ENCONTRADA') ? 'NOTA_NO_ENCONTRADA'
        : error.message.startsWith('YA_ANULADA') ? 'YA_ANULADA'
        : error.message.startsWith('PARCIAL_CONSUMIDO') ? 'PARCIAL_CONSUMIDO'
        : error.message.startsWith('CXP_CON_PAGOS') ? 'CXP_CON_PAGOS'
        : error.message.startsWith('ESTADO_NO_ANULABLE') ? 'ESTADO_NO_ANULABLE'
        : 'ERROR';
      return res.status(error.status).json({ message: error.message, tipo });
    }
    const status = typeof error?.status === 'number' ? error.status : 400;
    return res.status(status).json({
      message: 'Error al anular la nota de entrada',
      ...(error?.message ? { error: error.message } : {})
    });
  }
};