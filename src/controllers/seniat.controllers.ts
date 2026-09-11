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

/** Escape RFC-4180 para delimitador punto y coma. */
function escSC(v: unknown): string {
  const s = v?.toString() ?? '';
  return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * CSV separado por PUNTO Y COMA (normativa SENIAT). Incluye BOM UTF-8 (\uFEFF)
 * para que Excel en Windows no rompa caracteres latinos (ñ/acentos en Razón
 * Social y RIF). Las filas terminan en CRLF.
 */
function csvSemicolon(encabezado: string[], filas: unknown[][]): string {
  const lineas = [encabezado.map(escSC).join(';')];
  for (const f of filas) lineas.push(f.map(escSC).join(';'));
  return '\uFEFF' + lineas.join('\r\n');
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

const ENC_VENTAS_BS = [
  // Encabezado SENIAT en Bolívares (tasa BCV histórica) y delimitador ';'.
  // Separación estructural de rubros exentos (Base_Exenta) y gravados
  // (Base_Imponible), exigida por la Providencia. 16 columnas con el
  // desglose completo del IGTF: Base (divisas a tasa) + Alícuota + Monto.
  'N_Operacion', 'Fecha', 'RIF', 'Razon_Social', 'Nro_Factura',
  'Nro_Control', 'Tipo_Documento', 'Nro_Factura_Afectada',
  'Base_Exenta_Bs', 'Base_Imponible_Bs', 'Alicuota_%', 'IVA_Bs',
  'Base_IGTF_Bs', 'Alicuota_IGTF_%', 'IGTF_Bs', 'Retencion_IVA_Bs',
  'Total_Venta_Bs',
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
      // Extracción fiscal SENIAT en Bolívares usando la tasa BCV histórica de
      // cada factura; columnas separadas por punto y coma (Excel/Profit/Saint).
      const cuerpo = filas.map((v) => {
        const t = v.tasaBcv || 0;
        const red2 = (n: number) => n.toFixed(2);
        return [
          v.operacion,
          v.fecha,
          (v.rifCliente ?? '').toUpperCase(), // RIF con prefijo V/J/E/G
          v.razonSocial,
          v.facturaId,
          v.numeroControl,
          v.tipoDocumento, // FACTURA | NOTA_CREDITO (los montos negativos restan)
          v.facturaAfectada ?? '', // Nro_Factura_Afectada (solo Notas de Crédito)
          red2(v.baseExentaUsd * t), // Base_Exenta_Bs
          red2(v.baseImponibleUsd * t), // Base_Imponible_Bs
          v.alicuota, // Alicuota_%
          red2(v.ivaDebitoUsd * t), // IVA_Bs
          red2((v.baseIgtfUsd ?? 0) * t), // Base_IGTF_Bs (divisas a tasa BCV)
          (v.igtfUsd ?? 0) !== 0 ? '3' : '0', // Alicuota_IGTF_%
          red2(v.igtfUsd * t), // IGTF_Bs
          '0.00', // Retencion_IVA_Bs (módulo de retenciones aún no modelado)
          red2(v.totalUsd * t), // Total_Venta_Bs
        ];
      });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="libro_ventas_${anio}-${String(mes).padStart(2, '0')}.csv"`
      );
      return res.send(csvSemicolon(ENC_VENTAS_BS, cuerpo));
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