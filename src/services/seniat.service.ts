// adrialga-backend/src/services/seniat.service.ts
// Reportes fiscales conforme al SENIAT (Providencia SNAT/2014/00871):
// Libro de Ventas con IVA-Forma Liberada, Libro de Compras y Resumen de IVA.
// Los montos se devuelven en USD (moneda funcional del sistema) junto con la
// tasa BCV histórica por documento para la conversión a Bs (obligación de
// facturación en bolívares a la tasa oficial del día — Gaceta Oficial 6.152).
import { prisma } from '../config/db';

const num = (v: unknown): number => Number(v ?? 0) || 0;

export interface FilaLibroVentas {
  operacion: number;
  fecha: string;
  facturaId: number;
  numeroControl: string;
  rifCliente: string;
  razonSocial: string;
  // Ventas exentas y/o sin derecho a crédito fiscal (diferenciadas del gravamen)
  baseExentaUsd: number;
  baseImponibleUsd: number; // base gravada (16%) — NEGATIVA en Notas de Crédito
  alicuota: number; // 16 IVA | 0 si exenta
  ivaDebitoUsd: number; // NEGATIVO en Notas de Crédito
  igtfUsd: number; // 3% sobre pagos en divisas (Impuesto a las Grandes Transacciones)
  totalUsd: number; // NEGATIVO en Notas de Crédito
  tasaBcv: number;
  totalBs: number;
  // P0.4: tipo de comprobante y factura afectada (solo NC).
  tipoDocumento: 'FACTURA' | 'NOTA_CREDITO';
  facturaAfectada: string | null;
}

export interface FilaLibroCompras {
  operacion: number;
  fecha: string;
  notaId: number;
  numeroNota: string;
  rifProveedor: string;
  razonSocial: string;
  baseImponibleUsd: number; // costo neto (Total_Costo de la nota de entrada)
  alicuota: number;
  ivaCreditoUsd: number; // 0.00: notas de recepción sin IVA desglosado (ver nota)
  totalUsd: number;
}

export interface ResumenIVA {
  anio: number;
  mes: number;
  ventas: {
    documentos: number;
    baseExentaUsd: number;
    baseImponibleUsd: number;
    ivaDebitoUsd: number;
    igtfUsd: number;
    totalUsd: number;
  };
  compras: {
    documentos: number;
    baseImponibleUsd: number;
    ivaCreditoUsd: number;
    totalUsd: number;
  };
  ivaAPagarUsd: number; // débito − crédito
}

/** Rango [inicio, fin) del mes consultado en UTC. */
function rangoMes(anio: number, mes: number): { desde: Date; hasta: Date } {
  return {
    desde: new Date(Date.UTC(anio, mes - 1, 1)),
    hasta: new Date(Date.UTC(anio, mes, 1)),
  };
}

function fechaISO(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export const SeniatService = {
  async libroVentas(anio: number, mes: number): Promise<FilaLibroVentas[]> {
    const { desde, hasta } = rangoMes(anio, mes);
    // Incluye facturas regulares (Pagada/Completada) y Notas de Crédito (Emitida)
    // para que las fechas/importes negativos de las NC resten en la declaración.
    const facturas = await prisma.facturas.findMany({
      where: {
        Fecha_Emision: { gte: desde, lt: hasta },
        Estatus: { in: ['Completada', 'Pagada', 'Emitida'] }
      },
      include: {
        clientes: true,
        // Para resolver el Número de Control de la factura afectada por una NC.
        // (Relación opcional negada manualmente por FK no mapeada; se consulta aparte.)
      },
      orderBy: { Fecha_Emision: 'asc' },
    });

    // Mapa Factura_ID → Numero_Control para resolver la "factura afectada" (NC).
    const controles = new Map<number, string>();
    for (const f of facturas) controles.set(f.Factura_ID, f.Numero_Control ?? '');

    return facturas.map((f, i) => {
      const esNC = (f.Tipo_Documento ?? 'FACTURA') === 'NOTA_CREDITO' || f.Estatus === 'Emitida';
      const base = num(f.Subtotal);
      const iva = num(f.Total_IVA);
      const igtf = num(f.Monto_IGTF);
      const total = num(f.Total_General);
      const tasa = num(f.Tasa_Cambio);
      // Base gravada derivada del IVA (16%); NEGATIVA en NC. Si no hay IVA (exento)
      // la base gravada es 0 y el rubro exento conserva su signo.
      const baseGravada = iva !== 0 ? (iva * 100) / 16 : 0;
      return {
        operacion: i + 1,
        fecha: fechaISO(f.Fecha_Emision),
        facturaId: f.Factura_ID,
        numeroControl: f.Numero_Control ?? '',
        rifCliente: f.clientes.RIF_Cedula,
        razonSocial: f.clientes.Razon_Social,
        baseExentaUsd: esNC ? 0 : Math.max(0, base - baseGravada),
        baseImponibleUsd: baseGravada,
        alicuota: iva !== 0 ? 16 : 0,
        ivaDebitoUsd: iva,
        igtfUsd: igtf,
        totalUsd: total,
        tasaBcv: tasa,
        totalBs: Number((total * tasa).toFixed(2)),
        tipoDocumento: esNC ? 'NOTA_CREDITO' : 'FACTURA',
        facturaAfectada: esNC
          ? (controles.get(f.Factura_Afectada_ID ?? -1) ?? '')
          : null,
      };
    });
  },

  async libroCompras(anio: number, mes: number): Promise<FilaLibroCompras[]> {
    const { desde, hasta } = rangoMes(anio, mes);
    const notas = await prisma.notas_entrega_entrada.findMany({
      where: { Fecha_Recepcion: { gte: desde, lt: hasta }, Estatus: 'Procesada' },
      include: { proveedores: true },
      orderBy: { Fecha_Recepcion: 'asc' },
    });

    // Nota fiscal: las notas de recepción registran costo neto sin IVA
    // desglosado, por lo que el crédito fiscal reportado es 0.00 hasta que
    // el sistema soporte facturas de compra con IVA separado.
    return notas.map((n, i) => {
      const base = num(n.Total_Costo);
      return {
        operacion: i + 1,
        fecha: fechaISO(n.Fecha_Recepcion),
        notaId: n.Nota_ID,
        numeroNota: n.Numero_Nota,
        rifProveedor: n.proveedores.RIF_Cedula,
        razonSocial: n.proveedores.Razon_Social,
        baseImponibleUsd: base,
        alicuota: 0,
        ivaCreditoUsd: 0,
        totalUsd: base,
      };
    });
  },

  async resumenIVA(anio: number, mes: number): Promise<ResumenIVA> {
    const [ventas, compras] = await Promise.all([
      this.libroVentas(anio, mes),
      this.libroCompras(anio, mes),
    ]);
    const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);

    const ventasR = {
      documentos: ventas.length,
      baseExentaUsd: Number(sum(ventas.map((v) => v.baseExentaUsd)).toFixed(2)),
      baseImponibleUsd: Number(sum(ventas.map((v) => v.baseImponibleUsd)).toFixed(2)),
      ivaDebitoUsd: Number(sum(ventas.map((v) => v.ivaDebitoUsd)).toFixed(2)),
      igtfUsd: Number(sum(ventas.map((v) => v.igtfUsd)).toFixed(2)),
      totalUsd: Number(sum(ventas.map((v) => v.totalUsd)).toFixed(2)),
    };
    const comprasR = {
      documentos: compras.length,
      baseImponibleUsd: Number(sum(compras.map((c) => c.baseImponibleUsd)).toFixed(2)),
      ivaCreditoUsd: Number(sum(compras.map((c) => c.ivaCreditoUsd)).toFixed(2)),
      totalUsd: Number(sum(compras.map((c) => c.totalUsd)).toFixed(2)),
    };
    return {
      anio,
      mes,
      ventas: ventasR,
      compras: comprasR,
      ivaAPagarUsd: Number((ventasR.ivaDebitoUsd - comprasR.ivaCreditoUsd).toFixed(2)),
    };
  },
};