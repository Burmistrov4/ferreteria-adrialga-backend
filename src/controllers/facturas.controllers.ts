import { Request, Response } from 'express';
import { prisma } from '../config/db';
import { AuthRequest } from '../middlewares/auth.middleware';
import { normalizarPeriodo, calcularRango, rangoPersonalizado } from '../utils/fechas';
import { toD4, addD4, mulD4, divD4, aDecimal, IVA_ALIQUOTA, IGTF_ALIQUOTA, CIEN } from '../utils/dinero';
import { exigirCajaAbierta, CajaCerradaError, ArqueoPendienteError } from '../utils/caja';
import { validarPinSupervisorHash } from '../utils/pin_supervisor';

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

/**
 * Asigna el siguiente Número de Control fiscal (formato 00-00-XXXXXXXX).
 * El contador es una fila de `contadores_fiscales` incrementada atómicamente
 * dentro de la transacción de la factura (upsert + increment): garantiza
 * secuencia única sin huecos ni duplicados ante ventas concurrentes.
 * La serie reinicia por año natural (CTRL-VENTAS-<anio>).
 */
async function asignarNumeroControl(tx: any): Promise<string> {
  const anio = new Date().getUTCFullYear();
  const clave = `CTRL-VENTAS-${anio}`;
  const contador = await tx.contadores_fiscales.upsert({
    where: { Clave: clave },
    create: { Clave: clave, Valor: 1 },
    update: { Valor: { increment: 1 } },
  });
  return `00-00-${String(contador.Valor).padStart(8, '0')}`;
}

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

// Métodos de pago considerados en divisas extranjeras (base del IGTF 3%).
// Todo lo demás (VES, Pago Móvil, Punto de Venta) se asume en bolívares.
const METODOS_DIVISA = ['efectivo usd', 'zelle', 'efectivo (usd)', 'divisas'];

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

    const facturas = await prisma.facturas.findMany({
      where,
      orderBy: { Fecha_Emision: 'desc' },
      include: {
        clientes: true,
        usuarios: { select: { Usuario_ID: true, Nombre: true } },
        detalle_facturas: { include: { productos: true } },
        pagos: true
      }
    });
    return res.json(facturas.map(sanitizarFactura));
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

    return res.json(sanitizarFactura(factura));
  } catch (error) {
    return res.status(500).json({ message: 'Error al obtener la factura', error });
  }
};

export const createFactura = async (req: AuthRequest, res: Response) => {
  // Se acepta 'detalles' o 'Detalles' indiferentemente para ser tolerante con el cliente
  const { Cliente_ID, Numero_Control } = req.body;
  const detalles = req.body.detalles ?? req.body.Detalles;
  const Usuario_ID = req.user?.usuarioId;
  if (!Usuario_ID) {
    return res.status(401).json({ message: 'Token sin identificación de usuario' });
  }

  if (!Cliente_ID || !detalles || !Array.isArray(detalles) || detalles.length === 0) {
    return res.status(400).json({
      message: 'Cliente_ID y al menos un detalle son obligatorios'
    });
  }

  // El cliente debe EXISTIR en el maestro: el frontend nunca fuerza un ID
  // hardcodeado; se exige selección explícita (o el checkbox "Consumidor
  // Final" que resuelve a un registro real V-00000000 creado por el seed).
  const clienteExiste = await prisma.clientes.findUnique({
    where: { Cliente_ID: Number(Cliente_ID) },
    select: { Cliente_ID: true },
  });
  if (!clienteExiste) {
    return res.status(404).json({
      message: 'El cliente seleccionado no existe. Revise la asignación antes de cobrar.'
    });
  }

  // Detalle de pagos (multipago) enviado por el módulo de cobro del POS.
  // Shape esperado: { efectivoUSD, efectivoVES, pagoMovil, puntoVenta, referencia? }
  const dp = req.body.Detalles_Pago ?? req.body.detallesPago ?? {};
  const referenciaPago = (dp.referencia ?? null) as string | null;

  // ── Regla fiscal: la tasa BCV histórica es obligatoria para facturar ──────
  const tasaD4 = toD4(req.body.Tasa_Cambio ?? dp.tasaCambio);
  if (tasaD4 <= 0n) {
    return res.status(400).json({
      message:
        'La tasa BCV es obligatoria para emitir una factura (no se pudo determinar la tasa de cambio)'
    });
  }
  const tasaHistorica = aDecimal(tasaD4);

  // Pagos normalizados a 4 decimales, con marca de divisa extranjera.
  // (metodo, monto escalado)
  const pagosNormalizados = [
    { metodo: 'Efectivo USD', monto: toD4(dp.efectivoUSD) },
    { metodo: 'Efectivo VES', monto: toD4(dp.efectivoVES) },
    { metodo: 'Pago Móvil', monto: toD4(dp.pagoMovil) },
    { metodo: 'Punto de Venta', monto: toD4(dp.puntoVenta) }
  ].filter((p) => p.monto > 0n);

  const esDivisa = (metodo: string) =>
    METODOS_DIVISA.some((d) => metodo.toLowerCase().includes(d));

  // ── Motor fiscal (precisión exacta 4 decimales, sin floats) ──────────────
  // Base Imponible (USD) = Σ (Cantidad × Precio_Unitario)
  let baseImponible = 0n;
  for (const item of detalles) {
    baseImponible = addD4(
      baseImponible,
      mulD4(toD4(item.Cantidad), toD4(item.Precio_Unitario))
    );
  }
  // IVA (16%)
  const totalIva = divD4(mulD4(baseImponible, IVA_ALIQUOTA), CIEN);
  // IGTF (3%) sobre pagos en divisas EXCLUSIVAMENTE
  const pagosEnDivisas = pagosNormalizados
    .filter((p) => esDivisa(p.metodo))
    .reduce((acc, p) => addD4(acc, p.monto), 0n);
  const montoIgtf = divD4(mulD4(pagosEnDivisas, IGTF_ALIQUOTA), CIEN);
  const montoIgtfBs = mulD4(montoIgtf, tasaD4);
  // Total General = Base + IVA + IGTF
  const totalGeneral = addD4(addD4(baseImponible, totalIva), montoIgtf);

  try {
    const resultado = await prisma.$transaction(async (tx) => {
      // 1. Validar stock disponible y capturar el costo promedio vigente de cada producto
      const costosPorProducto = new Map<number, bigint>();
      for (const item of detalles) {
        const prod = await tx.productos.findUnique({
          where: { Producto_ID: Number(item.Producto_ID) }
        });

        if (!prod || prod.Stock_Actual < Number(item.Cantidad)) {
          throw new Error(`Stock insuficiente para el producto: ${prod?.Nombre || item.Producto_ID}`);
        }
        costosPorProducto.set(Number(item.Producto_ID), toD4(prod.Costo_Promedio));
      }

      // 3. Crear cabecera y detalles de la factura (montos exactos a 4 decimales)
      // ── Numeración fiscal SENIAT: si el cliente no envía Número de Control,
      // se asigna la secuencia transaccional 00-00-XXXXXXXX por año.
      const numeroControl = Numero_Control || (await asignarNumeroControl(tx));

      const nuevaFactura = await tx.facturas.create({
        data: {
          Cliente_ID: Number(Cliente_ID),
          Usuario_ID: Number(Usuario_ID),
          Numero_Control: numeroControl,
          Subtotal: aDecimal(baseImponible),
          Total_IVA: aDecimal(totalIva),
          Total_General: aDecimal(totalGeneral),
          // Tasa BCV histórica (obligatoria, 4 decimales)
          Tasa_Cambio: tasaHistorica,
          // IGTF 3% sobre pagos en divisas (USD) y su equivalencia en Bs
          Monto_IGTF: aDecimal(montoIgtf),
          Estatus: 'Pagada',
          detalle_facturas: {
            create: detalles.map((d: any) => {
              const cantidad = toD4(d.Cantidad);
              const precio = toD4(d.Precio_Unitario);
              return {
                Producto_ID: Number(d.Producto_ID),
                Cantidad: Number(d.Cantidad),
                Precio_Unitario: aDecimal(precio),
                // Congela el costo promedio ponderado vigente al momento de la venta
                // para poder calcular el margen de ganancia histórico.
                Costo_Unitario_Historico: aDecimal(
                  costosPorProducto.get(Number(d.Producto_ID)) ?? 0n
                ),
                Subtotal: aDecimal(mulD4(cantidad, precio))
              };
            })
          },
          // Persistencia del multipago: cada método con su monto, referencia (si aplica),
          // marca de divisa extranjera y la tasa de cambio usada en ese momento.
          pagos: {
            create: pagosNormalizados.map((p) => ({
              Metodo_Pago: p.metodo,
              Monto: aDecimal(p.monto),
              Referencia: referenciaPago,
              Es_Divisa: esDivisa(p.metodo),
              Tasa_Cambio: tasaHistorica
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

      // 5. Impacto en Tesorería: INGRESO en caja por cada pago recibido
      //    (misma transacción que la factura) + aumento del saldo de caja.
      if (pagosNormalizados.length > 0) {
        // Regla de negocio (arqueo): toda venta exige un turno de caja abierto.
        const caja = await exigirCajaAbierta(tx);
        const sumaPagos = pagosNormalizados.reduce((acc, p) => addD4(acc, p.monto), 0n);
        for (const p of pagosNormalizados) {
          await tx.movimientos_caja.create({
            data: {
              Caja_ID: caja.Caja_ID,
              Tipo: 'INGRESO',
              Concepto: `Cobro factura #${nuevaFactura.Factura_ID} (${numeroControl})`,
              Metodo_Pago: p.metodo,
              Monto_USD: aDecimal(p.monto),
              Tasa_Cambio: tasaHistorica,
              Referencia: referenciaPago,
              Origen_Tipo: 'factura',
              Origen_ID: nuevaFactura.Factura_ID
            }
          });
        }
        await tx.caja.update({
          where: { Caja_ID: caja.Caja_ID },
          data: { Saldo_Actual: { increment: aDecimal(sumaPagos) } }
        });
      }

      return nuevaFactura;
    });

    return res.status(201).json({ message: 'Factura registrada exitosamente', factura: resultado });
  } catch (error: any) {
    // Serialización por instancia (no por status): un 409 puede significar
    // caja cerrada O arqueo pendiente de una jornada anterior.
    if (error instanceof ArqueoPendienteError) {
      return res.status(error.status).json({ error: error.message, tipo: 'ARQUEO_PENDIENTE' });
    }
    if (error instanceof CajaCerradaError) {
      return res.status(error.status).json({ error: error.message, tipo: 'CAJA_CERRADA' });
    }
    const status = typeof error?.status === 'number' ? error.status : 400;
    return res.status(status).json({
      error: error.message || 'Error al procesar la venta',
      ...(status === 409 ? { tipo: 'CAJA_CERRADA' } : {})
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
      // A. Turno de caja abierto obligatorio.
      const caja = await exigirCajaAbierta(tx);

      // Total a devolver y verificación de fondo (CERO DÉFICIT).
      const refundD4 = facturaOriginal.pagos.reduce(
        (acc, p) => addD4(acc, toD4(p.Monto)),
        0n
      );
      if (refundD4 > toD4(caja.Saldo_Actual)) {
        throw new ReversionSaldoError(
          `Saldo insuficiente en caja: la devolución de ${aDecimal(refundD4)} USD excede el saldo disponible de ${Number(caja.Saldo_Actual).toFixed(2)} USD. ` +
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
          Autorizado_Por_ID: autorizadoPorId
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
      }

      // E. Egresos en caja (espejo de los pagos originales) + descuento de saldo.
      const sumaPagos = facturaOriginal.pagos.reduce(
        (acc, p) => addD4(acc, toD4(p.Monto)),
        0n
      );
      for (const p of facturaOriginal.pagos) {
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
        data: { Saldo_Actual: { decrement: aDecimal(sumaPagos) } }
      });

      return nc;
    });

    return res.status(201).json({ message: 'Venta reversada correctamente', notaCredito: resultado });
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