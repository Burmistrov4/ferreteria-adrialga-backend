import { Request, Response } from 'express';
import { prisma } from '../config/db';
import { AuthRequest } from '../middlewares/auth.middleware';
import { toD4, addD4, mulD4, divD4, aDecimal, IVA_ALIQUOTA, IGTF_ALIQUOTA, CIEN } from '../utils/dinero';

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
      const numeroControl =
        Numero_Control || `FV-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}`;

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

      return nuevaFactura;
    });

    return res.status(201).json({ message: 'Factura registrada exitosamente', factura: resultado });
  } catch (error: any) {
    return res.status(400).json({ error: error.message || 'Error al procesar la venta' });
  }
};