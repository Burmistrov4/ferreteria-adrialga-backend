import { Request, Response } from 'express';
import { Prisma } from '@prisma/client';
import { prisma } from '../config/db';
import { AuthRequest } from '../middlewares/auth.middleware';
import { normalizarPeriodo, calcularRango, rangoPersonalizado } from '../utils/fechas';
import { toD4, addD4, mulD4, divD4, aDecimal, IVA_ALIQUOTA, IGTF_ALIQUOTA, CIEN } from '../utils/dinero';
import { exigirCajaAbierta, CajaCerradaError, ArqueoPendienteError, esEfectivo, reintentarEnDeadlock } from '../utils/caja';
import { validarPinSupervisorHash } from '../utils/pin_supervisor';
import { IoStore } from '../utils/socket';
import { responderErrorPrisma } from '../utils/errores';
import {
  StockInsuficienteError,
  calcularDesgloseFiscal,
  procesarVenta,
  esDivisaMetodo,
  type LineaVentaEntrada,
  type PagoMixtoEntrada,
} from '../services/motor_ventas.service';

/**
 * Error semántico: la gaveta no cubre la devolución (regla CERO DÉFICIT).
 * Serializa como HTTP 400 para que el cajero solicite un Ingreso de Caja.
 */
export class ReversionSaldoError extends Error {
  public status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'ReversionSaldoError';
  }
}

// La asignación del Número de Control fiscal ahora vive en el motor de ventas
// (motor_ventas.service.ts → asignarNumeroControl) y se resuelve dentro de la
// transacción, eliminando la duplicación y el `tx: any`.

/**
 * Asigna el Número de Control de una Nota de Crédito usando una serie
 * INDEPENDIENTE (CTRL-NC-<anio>), como exige el SENIAT: las NC llevan
 * correlativo de control propio, aislado de las facturas regulares.
 */
async function asignarNCControl(tx: any): Promise<string> {
  const anio = new Date().getUTCFullYear();
  const clave = `CTRL-NC-${anio}`;
  const contador = await tx.contadores_fiscales.upsert({
    where: { Clave: clave },
    create: { Clave: clave, Valor: 1 },
    update: { Valor: { increment: 1 } },
  });
  // Serie propia con prefijo NC-<año>- para no colisionar con el N° de control
  // único global de las facturas regulares (00-00-XXXXXXXX).
  return `NC-${anio}-${String(contador.Valor).padStart(8, '0')}`;
}

// Métodos de pago considerados divisa extranjera y la marca de IGTF ahora
// residen en motor_ventas.service.ts (METODOS_DIVISA / esDivisaMetodo).

// Prisma devuelve las columnas DECIMAL como objetos Decimal (decimal.js).
// Su toJSON los serializa como cadena, pero lo convertimos a número de forma
// explícita para garantizar un contrato JSON numérico uniforme con el cliente.
const decToNumber = (v: any): number | null =>
  v === null || v === undefined ? null : Number(v.toString());

const sanitizarFactura = (f: any) =>
  f && {
    ...f,
    Subtotal: decToNumber(f.Subtotal),
    Total_IVA: decToNumber(f.Total_IVA),
    Monto_IGTF: decToNumber(f.Monto_IGTF),
    Total_General: decToNumber(f.Total_General),
    Tasa_Cambio: decToNumber(f.Tasa_Cambio),
    pagos: Array.isArray(f.pagos)
      ? f.pagos.map((p: any) => ({
          ...p,
          Monto: decToNumber(p.Monto),
          Tasa_Cambio: decToNumber(p.Tasa_Cambio)
        }))
      : f.pagos,
    detalle_facturas: Array.isArray(f.detalle_facturas)
      ? f.detalle_facturas.map((d: any) => ({
          ...d,
          Precio_Unitario: decToNumber(d.Precio_Unitario),
          Costo_Unitario_Historico: decToNumber(d.Costo_Unitario_Historico),
          Subtotal: decToNumber(d.Subtotal)
        }))
      : f.detalle_facturas
  };

export const getFacturas = async (req: Request, res: Response) => {
  try {
    // ── Filtro temporal opcional ─────────────────────────────────────────────
    // 1) Rango personal exacto: ?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
    // 2) Periodo relativo:      ?periodo=hoy|semana|mes|anio
    // 3) Sin parámetros:        historial completo.
    // La demarcación de bordes (00:00:00.000 / 23:59:59.999) se resuelve en
    // el backend (utils/fechas.ts), única fuente de verdad de fechas.
    const where: any = {};

    const desdeQ = req.query.desde?.toString();
    const hastaQ = req.query.hasta?.toString();
    if (desdeQ && hastaQ) {
      const rango = rangoPersonalizado(desdeQ, hastaQ);
      if (!rango) {
        return res.status(400).json({
          message: 'Parámetros desde/hasta inválidos (use fechas YYYY-MM-DD)'
        });
      }
      where.Fecha_Emision = { gte: rango.desde, lte: rango.hasta };
    } else if (req.query.periodo) {
      const { desde, hasta } = calcularRango(normalizarPeriodo(req.query.periodo));
      where.Fecha_Emision = { gte: desde, lte: hasta };
    }

    // El historial puede crecer mucho: por defecto la pantalla de registro
    // solo necesita cabecera + cliente/usuario. Los detalles y pagos se cargan
    // bajo demanda mediante GET /facturas/:id al abrir/imprimir una factura.
    const resumen = req.query.resumen !== 'false';
    const facturas = await prisma.facturas.findMany({
      where,
      orderBy: { Fecha_Emision: 'desc' },
      include: {
        clientes: true,
        usuarios: { select: { Usuario_ID: true, Nombre: true } },
        ...(resumen
          ? {}
          : {
              detalle_facturas: { include: { productos: true, producto_variantes: { include: { atributos: true } } } },
              pagos: true,
            }),
      }
    });
    return res.json(facturas.map(sanitizarFactura));
  } catch (error) {
    return responderErrorPrisma(res, error, {
      recurso: 'factura',
      contexto: 'obtener las',
    });
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
        detalle_facturas: { include: { productos: true, producto_variantes: { include: { atributos: true } } } },
        pagos: true
      }
    });

    if (!factura) {
      return res.status(404).json({ message: 'Factura no encontrada' });
    }

    return res.json(sanitizarFactura(factura));
  } catch (error) {
    return responderErrorPrisma(res, error, {
      recurso: 'factura',
      contexto: 'obtener la',
    });
  }
};

interface DetallePagoEntrada {
  efectivoUSD?: unknown;
  efectivoVES?: unknown;
  pagoMovil?: unknown;
  puntoVenta?: unknown;
  referencia?: unknown;
  tasaCambio?: unknown;
}

/**
 * Valida y tipa el arreglo de detalles en el borde del controlador. Rechaza
 * cantidades no enteras/negativas y precios inválidos ANTES de tocar la base
 * de datos (defensa en profundidad + contrato fuerte para el motor de ventas).
 */
function normalizarLineas(crudo: unknown): LineaVentaEntrada[] {
  if (!Array.isArray(crudo)) {
    throw new Error('El detalle de la venta debe ser un arreglo');
  }
  return crudo.map((item, i) => {
    const li = item as {
      Producto_ID?: unknown;
      Variante_ID?: unknown;
      Cantidad?: unknown;
      Precio_Unitario?: unknown;
    };
    const productoId = Number(li.Producto_ID);
    const varianteId = li.Variante_ID == null ? null : Number(li.Variante_ID);
    const cantidad = Number(li.Cantidad);
    const precio = Number(li.Precio_Unitario);
    if (!Number.isFinite(productoId) || productoId <= 0) {
      throw new Error(`Detalle #${i + 1}: Producto_ID inválido`);
    }
    if (varianteId !== null && (!Number.isFinite(varianteId) || varianteId <= 0)) {
      throw new Error(`Detalle #${i + 1}: Variante_ID inválido`);
    }
    if (!Number.isInteger(cantidad) || cantidad <= 0) {
      throw new Error(`Detalle #${i + 1}: Cantidad debe ser un entero mayor a 0`);
    }
    if (!Number.isFinite(precio) || precio < 0) {
      throw new Error(`Detalle #${i + 1}: Precio_Unitario inválido`);
    }
    return {
      Producto_ID: productoId,
      Variante_ID: varianteId,
      Cantidad: cantidad,
      Precio_Unitario: precio,
    };
  });
}

export const createFactura = async (req: AuthRequest, res: Response) => {
  // Borde tolerante: se acepta 'detalles' o 'Detalles'.
  const { Cliente_ID, Numero_Control } = req.body as {
    Cliente_ID?: unknown;
    Numero_Control?: string;
  };
  const detallesCrudos = req.body.detalles ?? req.body.Detalles;
  const Usuario_ID = req.user?.usuarioId;
  if (Usuario_ID == null) {
    return res.status(401).json({ message: 'Token sin identificación de usuario' });
  }
  if (!Cliente_ID || !Array.isArray(detallesCrudos) || detallesCrudos.length === 0) {
    return res.status(400).json({ message: 'Cliente_ID y al menos un detalle son obligatorios' });
  }

  const clienteExiste = await prisma.clientes.findUnique({
    where: { Cliente_ID: Number(Cliente_ID) },
    select: { Cliente_ID: true },
  });
  if (!clienteExiste) {
    return res.status(404).json({
      message: 'El cliente seleccionado no existe. Revise la asignación antes de cobrar.',
    });
  }

  // Multipago del módulo POS, normalizado y TIPADO (sin `any`).
  const dp = (req.body.Detalles_Pago ?? req.body.detallesPago ?? {}) as DetallePagoEntrada;
  const referenciaPago =
    typeof dp.referencia === 'string' && dp.referencia.trim() !== ''
      ? dp.referencia.trim()
      : null;

  // ── Regla fiscal: la tasa BCV histórica es obligatoria para facturar ──────
  const tasaD4 = toD4(req.body.Tasa_Cambio ?? dp.tasaCambio);
  if (tasaD4 <= 0n) {
    return res.status(400).json({
      message:
        'La tasa BCV es obligatoria para emitir una factura (no se pudo determinar la tasa de cambio)',
    });
  }
  const tasaHistorica = aDecimal(tasaD4);

  // Vuelto que el POS entrega al cliente (en USD). Sale de la gaveta: el motor
  // lo descuenta del efectivo neto y registra su EGRESO para que el arqueo
  // cuadre. Se normaliza a número y se ignora cualquier valor no numérico.
  const vueltoUSD = Number(req.body.Vuelto_USD ?? 0) || 0;

  // Normalización de pagos a bigint D4, con marca de divisa resuelta por el motor.
  const pagosNormalizados: PagoMixtoEntrada[] = [
    { metodo: 'Efectivo USD', monto: toD4(dp.efectivoUSD), esDivisa: esDivisaMetodo('Efectivo USD') },
    { metodo: 'Efectivo VES', monto: toD4(dp.efectivoVES), esDivisa: esDivisaMetodo('Efectivo VES') },
    { metodo: 'Pago Móvil', monto: toD4(dp.pagoMovil), esDivisa: esDivisaMetodo('Pago Móvil') },
    { metodo: 'Punto de Venta', monto: toD4(dp.puntoVenta), esDivisa: esDivisaMetodo('Punto de Venta') },
  ].filter((p) => p.monto > 0n);

  let lineas: LineaVentaEntrada[];
  try {
    lineas = normalizarLineas(detallesCrudos);
  } catch (e) {
    const mensaje = e instanceof Error ? e.message : 'Detalle de venta inválido';
    return res.status(400).json({ message: mensaje });
  }

  // Cálculo fiscal PURO (determinista, sin I/O) — fuera de la transacción.
  const desglose = calcularDesgloseFiscal(lineas, pagosNormalizados, tasaD4);

  try {
    // El motor de ventas ejecuta la reserva de inventario + creación de
    // factura + registro de pagos DENTRO de la transacción (ACID total).
    const resultado = await reintentarEnDeadlock(
      prisma,
      { timeout: 30000, maxWait: 20000 },
      (tx) =>
        procesarVenta(tx, {
          clienteId: Number(Cliente_ID),
          usuarioId: Number(Usuario_ID),
          numeroControl: Numero_Control,
          detalles: lineas,
          pagos: pagosNormalizados,
          desglose,
          tasaHistorica,
          referenciaPago,
          vueltoUSD,
        }),
    );

    // Hidratación completa post-commit para el comprobante de venta.
    const facturaCompleta = await prisma.facturas.findUnique({
      where: { Factura_ID: resultado.Factura_ID },
      include: {
        clientes: true,
        usuarios: { select: { Usuario_ID: true, Nombre: true } },
        pagos: true,
        detalle_facturas: {
          include: { productos: true, producto_variantes: { include: { atributos: true } } },
        },
      },
    });

    IoStore.emitDbUpdate(
      'ventas',
      `Nueva venta registrada: ${facturaCompleta?.Numero_Control ?? 'Factura'} (ID ${resultado.Factura_ID})`,
      { facturaId: resultado.Factura_ID },
    );

    return res.status(201).json({
      message: 'Factura registrada exitosamente',
      factura: sanitizarFactura(facturaCompleta),
    });
  } catch (error) {
    // Serialización por instancia (no por status): un 409 puede significar
    // caja cerrada, arqueo pendiente o stock insuficiente.
    if (error instanceof ArqueoPendienteError) {
      return res.status(error.status).json({ error: error.message, tipo: 'ARQUEO_PENDIENTE' });
    }
    if (error instanceof CajaCerradaError) {
      return res.status(error.status).json({ error: error.message, tipo: 'CAJA_CERRADA' });
    }
    if (error instanceof StockInsuficienteError) {
      return res.status(error.status).json({ error: error.message, tipo: error.tipo });
    }
    const status =
      typeof (error as { status?: number }).status === 'number'
        ? (error as { status?: number }).status!
        : 400;
    return res.status(status).json({
      error: error instanceof Error ? error.message : 'Error al procesar la venta',
      ...(status === 409 ? { tipo: 'CAJA_CERRADA' } : {}),
    });
  }
};

/**
 * POST /facturas/:id/reversar
 * Anulación fiscalmente correcta (P0.4). Ejecuta en UNA transacción ACID:
 *   A) Crea la Nota de Crédito fiscal (montos en negativo, serie CTRL-NC-<año>).
 *   B) Marca la factura original como REVERSADA (bloquea dobles devoluciones).
 *   C) Restituye el inventario recalculando el CMP a costo histórico con BigInt.
 *   D) Asienta los egresos en caja espejando los pagos originales y descuenta el
 *      saldo de gaveta, bloqueando el déficit (regla CERO DÉFICIT).
 * Si cualquier paso falla, el rollback completo evita descuadres fiscales/inventario.
 */
export const reversarVenta = async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const Usuario_ID = req.user?.usuarioId;
  if (!Usuario_ID) {
    return res.status(401).json({ message: 'Token sin identificación de usuario' });
  }

  // ── Autorización en caliente: un CAJERO requiere PIN de SUPERVISOR/ADMIN ──
  const rol = (req.user?.rol ?? '').toString().toUpperCase();
  const esSupervisor = rol === 'SUPERVISOR' || rol === 'ADMIN';
  let autorizadoPorId: number | null = null;
  if (!esSupervisor) {
    const pin = (req.body?.pinSupervisor ?? '').toString().trim();
    if (!pin) {
      return res.status(401).json({
        error: 'Se requiere autorización de Supervisor (PIN) para reversar ventas',
        tipo: 'SUPERVISOR_REQUERIDO'
      });
    }
    // Verificación bcrypt del PIN (nunca texto plano) contra los hashes de
    // los supervisores activos registrados.
    const supervisor = await validarPinSupervisorHash(prisma, pin);
    if (!supervisor) {
      return res.status(401).json({ error: 'PIN de Supervisor inválido', tipo: 'PIN_INVALIDO' });
    }
    autorizadoPorId = supervisor.Usuario_ID;
  }

  try {
    const facturaOriginal = await prisma.facturas.findUnique({
      where: { Factura_ID: Number(id) },
      include: { detalle_facturas: true, pagos: true }
    });

    // ── Gatekeepers previos a la transacción ─────────────────────────────────
    if (!facturaOriginal) {
      return res.status(404).json({ error: 'Factura no encontrada' });
    }
    if (facturaOriginal.Estatus === 'Reversada') {
      return res.status(400).json({ error: 'La factura ya fue reversada' });
    }
    if (facturaOriginal.Estatus !== 'Pagada' && facturaOriginal.Estatus !== 'Completada') {
      return res.status(400).json({
        error: `La factura no es reversible (Estatus: ${facturaOriginal.Estatus})`
      });
    }
    if ((facturaOriginal.Tipo_Documento ?? 'FACTURA') === 'NOTA_CREDITO') {
      return res.status(400).json({ error: 'Una Nota de Crédito no puede ser reversada' });
    }

    const resultado = await prisma.$transaction(async (tx) => {
      // A. Bloqueo de la factura: evita dos reversiones concurrentes.
      // El gatekeeper exterior es solo UX; la decisión definitiva ocurre
      // dentro de la misma transacción sobre la fila bloqueada.
      const facturaBloqueada = await tx.$queryRaw<Array<{ Factura_ID: number; Estatus: string }>>(Prisma.sql`
        SELECT Factura_ID, Estatus
        FROM facturas
        WHERE Factura_ID = ${Number(id)}
        FOR UPDATE
      `);
      if (facturaBloqueada.length === 0) {
        throw new Error('La factura no existe');
      }

      const facturaOriginal = await tx.facturas.findUnique({
        where: { Factura_ID: Number(id) },
        include: { detalle_facturas: true, pagos: true },
      });
      if (!facturaOriginal) {
        throw new Error('La factura no existe');
      }
      if (facturaOriginal.Estatus === 'Reversada') {
        throw new Error('La factura ya fue reversada');
      }
      if (facturaOriginal.Estatus !== 'Pagada' && facturaOriginal.Estatus !== 'Completada') {
        throw new Error(`La factura no es reversible (Estatus: ${facturaOriginal.Estatus})`);
      }

      // B. Bloqueo de inventario en el mismo orden que venta/entrada:
      // productos por ID creciente y luego variantes por ID creciente.
      // Esto evita que el CMP se calcule sobre una lectura concurrente vieja.
      const productoIdsReversion = Array.from(
        new Set(facturaOriginal.detalle_facturas.map((d) => d.Producto_ID)),
      ).sort((a, b) => a - b);
      const varianteIdsReversion = Array.from(
        new Set(
          facturaOriginal.detalle_facturas
            .map((d) => d.Variante_ID)
            .filter((v): v is number => v != null),
        ),
      ).sort((a, b) => a - b);

      if (productoIdsReversion.length > 0) {
        await tx.$queryRaw(Prisma.sql`
          SELECT Producto_ID
          FROM productos
          WHERE Producto_ID IN (${Prisma.join(productoIdsReversion)})
          FOR UPDATE
        `);
      }
      if (varianteIdsReversion.length > 0) {
        await tx.$queryRaw(Prisma.sql`
          SELECT Variante_ID
          FROM producto_variantes
          WHERE Variante_ID IN (${Prisma.join(varianteIdsReversion)})
          FOR UPDATE
        `);
      }

      // C. Turno de caja abierto obligatorio, después del inventario para
      // conservar el orden de bloqueo de los flujos financieros.
      const caja = await exigirCajaAbierta(tx);

      // Total a devolver de la GAVETA: solo los pagos hechos en efectivo
      // (los digitales se reembolsan por banco, nunca salen del cajón).
      const refundD4 = facturaOriginal.pagos
        .filter((p) => esEfectivo(p.Metodo_Pago))
        .reduce((acc, p) => addD4(acc, toD4(p.Monto)), 0n);
      if (refundD4 > toD4(caja.Saldo_Actual)) {
        // Refund en efectivo pero saldo insuficiente (CERO DÉFICIT).
        throw new ReversionSaldoError(
          `Saldo insuficiente en caja: la devolución en efectivo de ${aDecimal(refundD4)} USD excede el saldo disponible de ${Number(caja.Saldo_Actual).toFixed(2)} USD. ` +
          `Solicite un Ingreso de Caja al supervisor antes de procesar la devolución.`
        );
      }

      // B. Nota de Crédito: montos en NEGATIVO, Tipo_Documento y serie propios.
      const ncControl = await asignarNCControl(tx);
      const neg = (v: unknown) => -toD4(v);
      const nc = await tx.facturas.create({
        data: {
          Cliente_ID: facturaOriginal.Cliente_ID,
          Usuario_ID,
          Numero_Control: ncControl,
          Subtotal: aDecimal(neg(facturaOriginal.Subtotal)),
          Total_IVA: aDecimal(neg(facturaOriginal.Total_IVA)),
          Total_General: aDecimal(neg(facturaOriginal.Total_General)),
          Monto_IGTF: aDecimal(neg(facturaOriginal.Monto_IGTF)),
          Tasa_Cambio: aDecimal(toD4(facturaOriginal.Tasa_Cambio)),
          Estatus: 'Emitida',
          Tipo_Documento: 'NOTA_CREDITO',
          Factura_Afectada_ID: facturaOriginal.Factura_ID,
          Autorizado_Por_ID: autorizadoPorId,
          // Espejo fiscal: la NC replica ítems (cantidades y subtotales en
          // negativo) y los pagos devueltos — sin esto, el ticket de la NC
          // salía "vacío" y el libro ventas no cuadraba contra la factura.
          detalle_facturas: {
            create: facturaOriginal.detalle_facturas.map((d) => ({
              Producto_ID: d.Producto_ID,
              Variante_ID: d.Variante_ID ?? undefined,
              Cantidad: -d.Cantidad,
              Precio_Unitario: aDecimal(toD4(d.Precio_Unitario)),
              Costo_Unitario_Historico: aDecimal(toD4(d.Costo_Unitario_Historico)),
              Subtotal: aDecimal(neg(toD4(d.Subtotal)))
            }))
          },
          pagos: {
            create: facturaOriginal.pagos.map((p) => ({
              Metodo_Pago: p.Metodo_Pago,
              Monto: aDecimal(neg(toD4(p.Monto))),
              Referencia: p.Referencia,
              Es_Divisa: p.Es_Divisa,
              Tasa_Cambio: aDecimal(toD4(p.Tasa_Cambio ?? facturaOriginal.Tasa_Cambio))
            }))
          }
        }
      });

      // C. Mutar la original a REVERSADA.
      await tx.facturas.update({
        where: { Factura_ID: facturaOriginal.Factura_ID },
        data: { Estatus: 'Reversada' }
      });

      // D. Restituir inventario + recálculo de CMP a costo histórico (BigInt).
      for (const item of facturaOriginal.detalle_facturas) {
        const prod = await tx.productos.findUnique({
          where: { Producto_ID: item.Producto_ID }
        });
        const stockActual = toD4(prod?.Stock_Actual ?? 0);
        const cantidad = toD4(item.Cantidad);
        const cmp = toD4(prod?.Costo_Promedio);
        const costoHist = toD4(item.Costo_Unitario_Historico);
        const stockNuevo = addD4(stockActual, cantidad);
        // CMP_nuevo = (Stock*CMP + Cant*CostoHist) / (Stock + Cant)
        const nuevoCMP = stockNuevo > 0n
          ? divD4(addD4(mulD4(cmp, stockActual), mulD4(costoHist, cantidad)), stockNuevo)
          : costoHist;
        await tx.productos.update({
          where: { Producto_ID: item.Producto_ID },
          data: {
            Stock_Actual: { increment: item.Cantidad },
            Costo_Promedio: aDecimal(nuevoCMP)
          }
        });
        // Restitución matricial: la variante vendida recupera su stock.
        if (item.Variante_ID != null) {
          await tx.producto_variantes.update({
            where: { Variante_ID: item.Variante_ID },
            data: { Stock_Actual: { increment: item.Cantidad } }
          });
        }
      }

      // E. Egreso en caja: ÚNICAMENTE pagos en efectivo (los digitales se
      // reembolsan por banco: sin egreso en gaveta ni movimiento de caja).
      for (const p of facturaOriginal.pagos) {
        if (!esEfectivo(p.Metodo_Pago)) continue;
        await tx.movimientos_caja.create({
          data: {
            Caja_ID: caja.Caja_ID,
            Tipo: 'EGRESO',
            Concepto: `Reversión F-${facturaOriginal.Numero_Control ?? facturaOriginal.Factura_ID} NC-${ncControl}`,
            Metodo_Pago: p.Metodo_Pago,
            Monto_USD: aDecimal(toD4(p.Monto)),
            Tasa_Cambio: aDecimal(toD4(p.Tasa_Cambio ?? facturaOriginal.Tasa_Cambio)),
            Referencia: p.Referencia,
            Origen_Tipo: 'factura',
            Origen_ID: facturaOriginal.Factura_ID
          }
        });
      }
      await tx.caja.update({
        where: { Caja_ID: caja.Caja_ID },
        data: { Saldo_Actual: { decrement: aDecimal(refundD4) } }
      });

      return nc;
    }, {
      timeout: 30000,
      maxWait: 20000
    });

    // Hidratación idéntica post-commit para imprimir la NC con ítems y pagos.
    const ncCompleta = await prisma.facturas.findUnique({
      where: { Factura_ID: resultado.Factura_ID },
      include: {
        clientes: true,
        usuarios: { select: { Usuario_ID: true, Nombre: true } },
        pagos: true,
        detalle_facturas: { include: { productos: true, producto_variantes: { include: { atributos: true } } } }
      }
    });

    // Broadcast a todos los terminales (la devolución altera inventario).
    IoStore.emitDbUpdate(
      'ventas',
      `Venta #${id} reversada con Nota de Crédito`,
      { facturaOriginalId: Number(id) },
    );

    return res.status(201).json({
      message: 'Venta reversada correctamente',
      notaCredito: sanitizarFactura(ncCompleta)
    });
  } catch (error: any) {
    if (error instanceof ArqueoPendienteError) {
      return res.status(error.status).json({ error: error.message, tipo: 'ARQUEO_PENDIENTE' });
    }
    if (error instanceof CajaCerradaError) {
      return res.status(error.status).json({ error: error.message, tipo: 'CAJA_CERRADA' });
    }
    if (error instanceof ReversionSaldoError) {
      return res.status(error.status).json({ error: error.message, tipo: 'SALDO_INSUFICIENTE' });
    }
    return res.status(400).json({ error: error.message || 'Error al reversar la venta' });
  }
};