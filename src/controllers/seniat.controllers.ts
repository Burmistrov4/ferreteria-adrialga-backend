// adrialga-backend/src/controllers/seniat.controllers.ts
// Endpoints de reportes fiscales SENIAT. Formato: csv (BOM UTF-8, RFC-4180)
// o json. Query params: anio (default actual), mes (1-12, default actual).
import { Request, Response } from 'express';
import { SeniatService } from '../services/seniat.service';

function esc(v: unknown): string {
  const s = v?.toString() ?? '';
  return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csv(encabezado: string[], filas: unknown[][]): string {
  const lineas = [encabezado.join(',')];
  for (const f of filas) lineas.push(f.map(esc).join(','));
  // BOM UTF-8 para compatibilidad con Excel (igual que el libro diario)
  return '\ufeff' + lineas.join('\n');
}

/** Valida y normaliza anio/mes desde query params. */
function periodo(req: Request): { anio: number; mes: number } {
  const ahora = new Date();
  let anio = Number(req.query.anio ?? ahora.getUTCFullYear());
  let mes = Number(req.query.mes ?? ahora.getUTCMonth() + 1);
  if (!Number.isInteger(anio) || anio < 2000 || anio > 2100) anio = ahora.getUTCFullYear();
  if (!Number.isInteger(mes) || mes < 1 || mes > 12) mes = ahora.getUTCMonth() + 1;
  return { anio, mes };
}

const ENC_VENTAS = [
  'N_Operacion', 'Fecha', 'Factura_ID', 'Numero_Control', 'RIF_Cliente',
  'Razon_Social', 'Base_Exenta_USD', 'Base_Imponible_USD', 'Alicuota_%',
  'IVA_Debito_USD', 'IGTF_USD', 'Total_USD', 'Tasa_BCV', 'Total_Bs',
];

const ENC_COMPRAS = [
  'N_Operacion', 'Fecha', 'Nota_ID', 'Numero_Nota', 'RIF_Proveedor',
  'Razon_Social', 'Base_Imponible_USD', 'Alicuota_%', 'IVA_Credito_USD', 'Total_USD',
];

export const getLibroVentas = async (req: Request, res: Response) => {
  try {
    const { anio, mes } = periodo(req);
    const filas = await SeniatService.libroVentas(anio, mes);
    if (req.query.formato === 'csv') {
      const cuerpo = filas.map((v) => [
        v.operacion, v.fecha, v.facturaId, v.numeroControl, v.rifCliente,
        v.razonSocial, v.baseExentaUsd.toFixed(2), v.baseImponibleUsd.toFixed(2),
        v.alicuota, v.ivaDebitoUsd.toFixed(2), v.igtfUsd.toFixed(2),
        v.totalUsd.toFixed(2), v.tasaBcv.toFixed(4), v.totalBs.toFixed(2),
      ]);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="libro_ventas_${anio}-${String(mes).padStart(2, '0')}.csv"`
      );
      return res.send(csv(ENC_VENTAS, cuerpo));
    }
    return res.json({ anio, mes, total: filas.length, filas });
  } catch (error: any) {
    console.error('getLibroVentas:', error);
    return res.status(500).json({ error: 'Error generando el Libro de Ventas' });
  }
};

export const getLibroCompras = async (req: Request, res: Response) => {
  try {
    const { anio, mes } = periodo(req);
    const filas = await SeniatService.libroCompras(anio, mes);
    if (req.query.formato === 'csv') {
      const cuerpo = filas.map((c) => [
        c.operacion, c.fecha, c.notaId, c.numeroNota, c.rifProveedor,
        c.razonSocial, c.baseImponibleUsd.toFixed(2), c.alicuota,
        c.ivaCreditoUsd.toFixed(2), c.totalUsd.toFixed(2),
      ]);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="libro_compras_${anio}-${String(mes).padStart(2, '0')}.csv"`
      );
      return res.send(csv(ENC_COMPRAS, cuerpo));
    }
    return res.json({ anio, mes, total: filas.length, filas });
  } catch (error: any) {
    console.error('getLibroCompras:', error);
    return res.status(500).json({ error: 'Error generando el Libro de Compras' });
  }
};

export const getResumenIVA = async (req: Request, res: Response) => {
  try {
    const { anio, mes } = periodo(req);
    const resumen = await SeniatService.resumenIVA(anio, mes);
    return res.json(resumen);
  } catch (error: any) {
    console.error('getResumenIVA:', error);
    return res.status(500).json({ error: 'Error generando el resumen de IVA' });
  }
};