import { PrismaClient } from '@prisma/client';
import { asegurarCajaPrincipal } from '../utils/caja';

const prisma = new PrismaClient();

export const TesoreriaService = {
  async obtenerSaldoCaja() {
    const caja = await asegurarCajaPrincipal(prisma);
    const movimientos = await prisma.movimientos_caja.findMany({
      where: { Caja_ID: caja.Caja_ID },
      orderBy: { Movimiento_ID: 'desc' },
      take: 50,
    });
    return {
      caja: { ...caja, Saldo_Inicial: Number(caja.Saldo_Inicial), Saldo_Actual: Number(caja.Saldo_Actual) },
      movimientos: movimientos.map((m) => ({ ...m, Monto_USD: Number(m.Monto_USD), Tasa_Cambio: m.Tasa_Cambio === null ? null : Number(m.Tasa_Cambio) })),
    };
  },

  async calcularPatrimonioOperativo() {
    const caja = await asegurarCajaPrincipal(prisma);
    const productos = await prisma.productos.findMany({
      select: { Stock_Actual: true, Costo_Promedio: true },
    });

    const valorInventario = productos.reduce(
      (acc: number, p) => acc + Number(p.Stock_Actual) * Number(p.Costo_Promedio ?? 0),
      0
    );

    return {
      caja: Number(caja.Saldo_Actual),
      inventario: valorInventario,
      patrimonio: Number(caja.Saldo_Actual) + valorInventario,
    };
  },

  async listarCuentasPorPagar() {
    const cuentas = await prisma.cuentas_por_pagar.findMany({
      include: { proveedores: true },
      orderBy: { Vencimiento: 'asc' },
    });
    return cuentas.map((c) => ({
      ...c,
      Monto_Total: Number(c.Monto_Total),
      Monto_Pagado: Number(c.Monto_Pagado),
      Saldo: Number(c.Saldo),
    }));
  },

  async abonarCuentaPorPagar(cxpId: number, monto: number, metodoPago: string) {
    return prisma.$transaction(async (tx) => {
      const cxp = await tx.cuentas_por_pagar.findUnique({ where: { CxP_ID: cxpId } });
      if (!cxp) throw new Error('Cuenta por pagar no encontrada');

      const caja = await asegurarCajaPrincipal(tx);
      const nuevoMontoPagado = Number(cxp.Monto_Pagado) + monto;
      const nuevoSaldo = Number(cxp.Monto_Total) - nuevoMontoPagado;
      const nuevoEstatus = nuevoSaldo <= 0 ? 'Pagada' : 'Pendiente';

      const cxpActualizada = await tx.cuentas_por_pagar.update({
        where: { CxP_ID: cxpId },
        data: {
          Monto_Pagado: nuevoMontoPagado,
          Saldo: Math.max(0, nuevoSaldo),
          Estatus: nuevoEstatus,
        },
      });

      await tx.movimientos_caja.create({
        data: {
          Caja_ID: caja.Caja_ID,
          Tipo: 'EGRESO',
          Concepto: `Abono a CxP #${cxpId}`,
          Metodo_Pago: metodoPago,
          Monto_USD: monto,
          Origen_Tipo: 'cxp',
          Origen_ID: cxpId,
        },
      });

      await tx.caja.update({
        where: { Caja_ID: caja.Caja_ID },
        data: { Saldo_Actual: { decrement: monto } },
      });

      return cxpActualizada;
    });
  },
};

