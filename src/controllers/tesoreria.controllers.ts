import { Request, Response } from 'express';
import { TesoreriaService } from '../services/tesoreria.service';

export const getTesoreriaSaldo = async (_req: Request, res: Response) => {
  try {
    const data = await TesoreriaService.obtenerSaldoCaja();
    res.json(data);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const getPatrimonioOperativo = async (_req: Request, res: Response) => {
  try {
    const data = await TesoreriaService.calcularPatrimonioOperativo();
    res.json(data);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const getCuentasPorPagar = async (_req: Request, res: Response) => {
  try {
    const data = await TesoreriaService.listarCuentasPorPagar();
    res.json(data);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
};

export const abonarCuentaPorPagar = async (req: Request, res: Response) => {
  try {
    const { cxpId, monto, metodoPago } = req.body;
    const data = await TesoreriaService.abonarCuentaPorPagar(
      Number(cxpId),
      Number(monto),
      metodoPago ?? 'Efectivo'
    );
    res.json(data);
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};

