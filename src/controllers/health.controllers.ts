import { Request, Response } from 'express';
import { prisma } from '../config/db';

/**
 * GET /api/health
 *
 * Healthcheck de producción para balanceadores/monitoreo (uptime robots,
 * Docker HEALTHCHECK, etc.). Ejecuta la consulta más liviana posible contra
 * MySQL para verificar conectividad real (no solo que el proceso viva).
 *
 * 200 → { status: "ok", timestamp, database: "connected" }
 * 503 → { status: "error", timestamp, database: "disconnected", error }
 */
export const getHealth = async (_req: Request, res: Response) => {
  const timestamp = new Date().toISOString();
  try {
    await prisma.$queryRaw`SELECT 1`;
    return res.status(200).json({
      status: 'ok',
      timestamp,
      database: 'connected'
    });
  } catch (error) {
    console.error('Healthcheck: base de datos no responde:', error);
    return res.status(503).json({
      status: 'error',
      timestamp,
      database: 'disconnected',
      error: error instanceof Error ? error.message : String(error)
    });
  }
};
