// adrialga-backend/src/services/motor_ventas.service.ts
// ─────────────────────────────────────────────────────────────────────────────
// MOTOR DE TRANSACCIONES DE VENTA — Núcleo ACID libre de condiciones de carrera.
//
// Responsabilidad única: orquestar, DENTRO de UNA transacción Prisma, la
// reserva de inventario + registro de pagos mixtos de una factura, garantizando
// integridad referencial y financiera sin importar cuántos cajeros facturen el
// mismo producto en el mismo milisegundo.
//
// Estrategia anti-carrera (defensa en dos capas):
//   1) CERROJO PESIMISTA: `SELECT ... FOR UPDATE` sobre las filas de
//      `productos`/`producto_variantes` involucradas, en UN solo statement por
//      tabla y en orden determinístico (IDs crecientes). Esto serializa el
//      read-modify-write de un mismo producto entre transacciones concurrentes
//      y elimina la ventana de "lectura vieja" que existía en el diseño previo.
//   2) DESCUENTO ATÓMICO: `updateMany({ where: { Stock_Actual: { gte } },
//      data: { decrement } })`. El WHERE reevalúa el saldo en la misma sentencia
//      de MySQL; si otro hilo consumió el stock, `count: 0` ⇒ abort total.
//      Es la red de seguridad ACID, independiente del cerrojo.
//
// Principios: sin `any`, sin `as` unsafe, errores de dominio tipados, cálculo
// fiscal PURO (sin I/O) y separable, e inyección del `TransactionClient` para
// testabilidad (SOLID / bajo acoplamiento).
// ─────────────────────────────────────────────────────────────────────────────
import { Prisma } from '@prisma/client';
import {
  toD4,
  addD4,
  mulD4,
  divD4,
  aDecimal,
  IVA_ALIQUOTA,
  IGTF_ALIQUOTA,
  CIEN,
} from '../utils/dinero';
import { exigirCajaAbierta, esEfectivo } from '../utils/caja';

// Métodos de pago considerados divisa extranjera (base del IGTF 3%).
// Todo lo demás (VES, Pago Móvil, Punto de Venta) se asume en bolívares.
export const METODOS_DIVISA = [
  'efectivo usd',
  'zelle',
  'efectivo (usd)',
  'divisas',
] as const;

export function esDivisaMetodo(metodo: string): boolean {
  return METODOS_DIVISA.some((d) => metodo.toLowerCase().includes(d));
}

/**
 * Error de dominio: el inventario no cubre la venta. Serializa como HTTP 409
 * con tipo estable `STOCK_INSUFICIENTE` para que el POS bloquee el cobro y
 * sugiera ajuste/reabastecimiento. Nunca deja escapar un mensaje de ORM crudo.
 */
export class StockInsuficienteError extends Error {
  public readonly status = 409;
  public readonly tipo = 'STOCK_INSUFICIENTE' as const;
  constructor(message: string) {
    super(message);
    this.name = 'StockInsuficienteError';
  }
}

// ── Contratos de entrada (ya validados/tipados en el borde del controlador) ──
export interface LineaVentaEntrada {
  Producto_ID: number;
  Variante_ID: number | null;
  Cantidad: number; // entero > 0
  Precio_Unitario: number; // decimal >= 0
}

export interface PagoMixtoEntrada {
  metodo: string;
  monto: bigint; // escalado ×1e4 (D4)
  esDivisa: boolean;
}

export interface DesgloseFiscal {
  baseImponible: bigint;
  totalIva: bigint;
  pagosEnDivisas: bigint;
  montoIgtf: bigint;
  montoIgtfBs: bigint;
  totalGeneral: bigint;
}

export interface SolicitudVenta {
  clienteId: number;
  usuarioId: number;
  numeroControl: string | undefined; // crudo del request; se resuelve dentro de la tx
  detalles: LineaVentaEntrada[];
  pagos: PagoMixtoEntrada[];
  desglose: DesgloseFiscal;
  tasaHistorica: string; // aDecimal(tasaD4) — Decimal(18,6)
  referenciaPago: string | null;
  /** Vuelto entregado al cliente, en USD. Sale físicamente de la gaveta. */
  vueltoUSD?: number;
}

// ── Tipos de las lecturas con cerrojo (SELECT ... FOR UPDATE) ─────────────────
interface FilaStockProducto {
  Producto_ID: number;
  Stock_Actual: number;
  Costo_Promedio: Prisma.Decimal;
}
interface FilaStockVariante {
  Variante_ID: number;
  Producto_ID: number;
  Stock_Actual: number;
  Costo_Unitario: Prisma.Decimal;
}

/**
 * Asigna el siguiente Número de Control fiscal (formato 00-00-XXXXXXXX).
 * El contador es una fila de `contadores_fiscales` incrementada atómicamente
 * dentro de la transacción (upsert + increment): secuencia única sin huecos ni
 * duplicados ante ventas concurrentes. Serie por año (CTRL-VENTAS-<anio>).
 */
async function asignarNumeroControl(
  tx: Prisma.TransactionClient,
): Promise<string> {
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
 * Cálculo fiscal PURO (sin I/O, determinista, testeable de forma aislada).
 * Precisión fija 4 decimales vía BigInt; jamás toca la base de datos.
 *  - Base imponible = Σ (Cantidad × Precio_Unitario)
 *  - IVA 16% sobre la base.
 *  - IGTF 3% EXCLUSIVAMENTE sobre la porción cubierta en divisa.
 *  - Total = Base + IVA + IGTF.
 */
export function calcularDesgloseFiscal(
  detalles: LineaVentaEntrada[],
  pagos: PagoMixtoEntrada[],
  tasaD4: bigint,
): DesgloseFiscal {
  let baseImponible = 0n;
  for (const item of detalles) {
    baseImponible = addD4(
      baseImponible,
      mulD4(toD4(item.Cantidad), toD4(item.Precio_Unitario)),
    );
  }

  const totalIva = divD4(mulD4(baseImponible, IVA_ALIQUOTA), CIEN);

  const pagosEnDivisas = pagos
    .filter((p) => p.esDivisa)
    .reduce((acc, p) => addD4(acc, p.monto), 0n);

  const montoIgtf = divD4(mulD4(pagosEnDivisas, IGTF_ALIQUOTA), CIEN);
  const montoIgtfBs = mulD4(montoIgtf, tasaD4);
  const totalGeneral = addD4(addD4(baseImponible, totalIva), montoIgtf);

  return {
    baseImponible,
    totalIva,
    pagosEnDivisas,
    montoIgtf,
    montoIgtfBs,
    totalGeneral,
  };
}

/**
 * Reserva el inventario de forma atómica y devuelve el mapa de costo histórico
 * por línea (clave = Producto_ID + Variante_ID × 1e6) para congelar el margen.
 *
 * 1) Cerrojo pesimista + lectura actual (current read) de productos y variantes.
 * 2) Validación semántica contra los valores BLOQUEADOS (sin ventana de carrera).
 * 3) Descuento atómico con WHERE gte como red de seguridad ACID.
 *
 * Lanza [StockInsuficienteError] si algún producto/variante no existe o su
 * stock no alcanza — abortando toda la transacción (rollback automático).
 */
export async function reservarInventario(
  tx: Prisma.TransactionClient,
  detalles: LineaVentaEntrada[],
): Promise<Map<number, bigint>> {
  const costosPorDetalle = new Map<number, bigint>();

  // Conjuntos determinísticos (orden creciente) para evitar interbloqueos:
  // toda transacción bloquea productos y luego variantes en el mismo orden.
  const productoIds = Array.from(
    new Set(detalles.map((d) => d.Producto_ID)),
  ).sort((a, b) => a - b);
  const varianteIds = Array.from(
    new Set(
      detalles
        .map((d) => d.Variante_ID)
        .filter((v): v is number => v != null),
    ),
  ).sort((a, b) => a - b);

  // 1) CERROJO + lectura de productos.
  const filasProd: FilaStockProducto[] = productoIds.length
    ? await tx.$queryRaw<FilaStockProducto[]>(
        Prisma.sql`SELECT Producto_ID, Stock_Actual, Costo_Promedio
                   FROM productos
                   WHERE Producto_ID IN (${Prisma.join(productoIds)}) FOR UPDATE`,
      )
    : [];
  const mapaProd = new Map(filasProd.map((f) => [f.Producto_ID, f]));

  // 1b) CERROJO + lectura de variantes.
  const filasVar: FilaStockVariante[] = varianteIds.length
    ? await tx.$queryRaw<FilaStockVariante[]>(
        Prisma.sql`SELECT Variante_ID, Producto_ID, Stock_Actual, Costo_Unitario
                   FROM producto_variantes
                   WHERE Variante_ID IN (${Prisma.join(varianteIds)}) FOR UPDATE`,
      )
    : [];
  const mapaVar = new Map(filasVar.map((f) => [f.Variante_ID, f]));

  // 2) Validación semántica contra los valores BLOQUEADOS.
  for (const item of detalles) {
    const prod = mapaProd.get(item.Producto_ID);
    if (!prod) {
      throw new StockInsuficienteError(
        `El producto #${item.Producto_ID} no existe o fue dado de baja.`,
      );
    }
    if (prod.Stock_Actual < item.Cantidad) {
      throw new StockInsuficienteError(
        `Stock insuficiente para el producto #${item.Producto_ID} ` +
          `(dispone: ${prod.Stock_Actual}, requiere: ${item.Cantidad}).`,
      );
    }

    let costoLinea = toD4(prod.Costo_Promedio);
    if (item.Variante_ID != null) {
      const variante = mapaVar.get(item.Variante_ID);
      if (!variante || variante.Producto_ID !== item.Producto_ID) {
        throw new StockInsuficienteError(
          `La variante #${item.Variante_ID} no pertenece al producto #${item.Producto_ID}.`,
        );
      }
      if (variante.Stock_Actual < item.Cantidad) {
        throw new StockInsuficienteError(
          `Stock insuficiente de la variante #${item.Variante_ID} ` +
            `(dispone: ${variante.Stock_Actual}, requiere: ${item.Cantidad}).`,
        );
      }
      // Margen histórico de variante usa su costo real, no el CPP del padre.
      costoLinea = toD4(variante.Costo_Unitario);
    }

    costosPorDetalle.set(
      item.Producto_ID + (item.Variante_ID ?? 0) * 1_000_000,
      costoLinea,
    );
  }

  // 3) DESCUENTO ATÓMICO (backstop ACID). El WHERE gte reevalúa el saldo en la
  //    misma sentencia MySQL; con el cerrojo activo no puede fallar, pero el
  //    chequeo count===1 es la garantía final contra descuadres.
  for (const item of detalles) {
    const touched = await tx.productos.updateMany({
      where: {
        Producto_ID: item.Producto_ID,
        Stock_Actual: { gte: item.Cantidad },
      },
      data: { Stock_Actual: { decrement: item.Cantidad } },
    });
    if (touched.count !== 1) {
      throw new StockInsuficienteError(
        `Stock insuficiente para el producto #${item.Producto_ID}.`,
      );
    }
    if (item.Variante_ID != null) {
      const touchedV = await tx.producto_variantes.updateMany({
        where: {
          Variante_ID: item.Variante_ID,
          Stock_Actual: { gte: item.Cantidad },
        },
        data: { Stock_Actual: { decrement: item.Cantidad } },
      });
      if (touchedV.count !== 1) {
        throw new StockInsuficienteError(
          `Stock insuficiente para la variante #${item.Variante_ID}.`,
        );
      }
    }
  }

  return costosPorDetalle;
}

/**
 * Registra el cobro mixto en tesorería (misma transacción ⇒ ACID total):
 *  - Exige turno de caja abierto (regla de arqueo).
 *  - Solo el EFECTIVO (USD/VES físico) altera Saldo_Actual de la gaveta.
 *  - Digitales (Pago Móvil, Punto, Zelle) van al banco: se auditan en
 *    movimientos_caja pero NO contaminan el arqueo físico.
 */
export async function registrarPagosMixtos(
  tx: Prisma.TransactionClient,
  params: {
    facturaId: number;
    numeroControl: string;
    pagos: PagoMixtoEntrada[];
    tasaHistorica: string;
    referenciaPago: string | null;
    /** Vuelto entregado al cliente, en USD. Sale físicamente de la gaveta. */
    vueltoUSD?: number;
  },
): Promise<void> {
  if (params.pagos.length === 0) return; // sin cobro, sin impacto de caja

  const caja = await exigirCajaAbierta(tx);

  // ── Moneda y vuelto: lo que entra a la gaveta es USD NETO ──────────────
  // `Saldo_Actual` está en USD. Antes se sumaba `p.monto` tal cual: un pago
  // en "Efectivo VES" metía BOLÍVARES como si fueran dólares (una venta de
  // Bs 3.600 inflaba la gaveta en 3.600 "USD"). Además se acreditaba el
  // efectivo BRUTO y el vuelto entregado al cliente nunca salía de la caja.
  // Ahora cada pago efectivo se convierte a USD (los no-divisa se dividen por
  // la tasa histórica) y se descuenta el vuelto antes de incrementar.
  const tasaD4 = toD4(params.tasaHistorica);
  const aUsd = (p: PagoMixtoEntrada): bigint =>
    p.esDivisa ? p.monto : divD4(p.monto, tasaD4);

  const sumaEfectivoUSD = params.pagos
    .filter((p) => esEfectivo(p.metodo))
    .reduce((acc, p) => addD4(acc, aUsd(p)), 0n);

  const vueltoD4 = toD4(params.vueltoUSD ?? 0);
  const vueltoAplicado =
    vueltoD4 > sumaEfectivoUSD ? sumaEfectivoUSD : vueltoD4;
  const netoEfectivoUSD = sumaEfectivoUSD - vueltoAplicado;

  if (netoEfectivoUSD > 0n) {
    await tx.caja.update({
      where: { Caja_ID: caja.Caja_ID },
      data: { Saldo_Actual: { increment: aDecimal(netoEfectivoUSD) } },
    });
  }

  for (const p of params.pagos) {
    await tx.movimientos_caja.create({
      data: {
        Caja_ID: caja.Caja_ID,
        Tipo: 'INGRESO',
        Concepto: `Cobro factura #${params.facturaId} (${params.numeroControl})`,
        Metodo_Pago: p.metodo,
        Monto_USD: aDecimal(aUsd(p)),
        Tasa_Cambio: params.tasaHistorica,
        Referencia: params.referenciaPago,
        Origen_Tipo: 'factura',
        Origen_ID: params.facturaId,
      },
    });
  }

  // El vuelto es un EGRESO real de la gaveta: se deja rastro explícito para
  // que el arqueo cuadre (ingreso bruto − vuelto = neto acreditado).
  if (vueltoAplicado > 0n) {
    await tx.movimientos_caja.create({
      data: {
        Caja_ID: caja.Caja_ID,
        Tipo: 'EGRESO',
        Concepto: `Vuelto factura #${params.facturaId} (${params.numeroControl})`,
        Metodo_Pago: 'Efectivo USD',
        Monto_USD: aDecimal(vueltoAplicado),
        Tasa_Cambio: params.tasaHistorica,
        Referencia: params.referenciaPago,
        Origen_Tipo: 'factura',
        Origen_ID: params.facturaId,
      },
    });
  }
}

/**
 * Orquestador de la venta. Punto de entrada del motor: reserva inventario,
 * crea cabecera + detalles + pagos, y registra el impacto en tesorería, TODO
 * dentro del `tx` recibido (la transacción la abre el llamador). Devuelve las
 * claves de la factura para la hidratación post-commit.
 */
export async function procesarVenta(
  tx: Prisma.TransactionClient,
  solicitud: SolicitudVenta,
): Promise<{ Factura_ID: number; Numero_Control: string }> {
  // A) Reserva de inventario atómica + captura de costo histórico.
  const costosPorDetalle = await reservarInventario(tx, solicitud.detalles);

  // B) Numeración fiscal SENIAT (resuelta dentro de la tx si el cliente no envía).
  const numeroControl =
    solicitud.numeroControl || (await asignarNumeroControl(tx));

  const nuevaFactura = await tx.facturas.create({
    data: {
      Cliente_ID: solicitud.clienteId,
      Usuario_ID: solicitud.usuarioId,
      Numero_Control: numeroControl,
      Subtotal: aDecimal(solicitud.desglose.baseImponible),
      Total_IVA: aDecimal(solicitud.desglose.totalIva),
      Total_General: aDecimal(solicitud.desglose.totalGeneral),
      Tasa_Cambio: solicitud.tasaHistorica,
      Monto_IGTF: aDecimal(solicitud.desglose.montoIgtf),
      Estatus: 'Pagada',
      detalle_facturas: {
        create: solicitud.detalles.map((d) => {
          const cantidad = toD4(d.Cantidad);
          const precio = toD4(d.Precio_Unitario);
          const key = d.Producto_ID + (d.Variante_ID ?? 0) * 1_000_000;
          return {
            Producto_ID: d.Producto_ID,
            Variante_ID: d.Variante_ID ?? undefined,
            Cantidad: d.Cantidad,
            Precio_Unitario: aDecimal(precio),
            // Congela el costo vigente (CPP padre o costo real de variante)
            // para margen histórico exacto por ítem vendido.
            Costo_Unitario_Historico: aDecimal(
              costosPorDetalle.get(key) ?? 0n,
            ),
            Subtotal: aDecimal(mulD4(cantidad, precio)),
          };
        }),
      },
      pagos: {
        create: solicitud.pagos.map((p) => ({
          Metodo_Pago: p.metodo,
          Monto: aDecimal(p.monto),
          Referencia: solicitud.referenciaPago,
          Es_Divisa: p.esDivisa,
          Tasa_Cambio: solicitud.tasaHistorica,
        })),
      },
    },
    select: { Factura_ID: true, Numero_Control: true },
  });

  // C) Impacto en Tesorería (misma transacción ⇒ ACID total).
  await registrarPagosMixtos(tx, {
    facturaId: nuevaFactura.Factura_ID,
    numeroControl: nuevaFactura.Numero_Control ?? numeroControl,
    pagos: solicitud.pagos,
    tasaHistorica: solicitud.tasaHistorica,
    referenciaPago: solicitud.referenciaPago,
    vueltoUSD: solicitud.vueltoUSD,
  });

  return {
    Factura_ID: nuevaFactura.Factura_ID,
    Numero_Control: nuevaFactura.Numero_Control ?? numeroControl,
  };
}
