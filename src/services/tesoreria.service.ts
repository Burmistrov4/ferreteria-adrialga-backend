import { PrismaClient } from '@prisma/client';
import { exigirCajaAbierta, asegurarCajaPrincipal } from '../utils/caja';
import { toD4, mulD4, divD4, aDecimal } from '../utils/dinero';

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

  /// Verifica si hay fondos suficientes en caja para dar vuelto.
  /// [montoUSD] y [montoVES] representan el vuelto requerido en cada moneda.
  /// Retorna { puedeProcesar: boolean, saldoUSD: number, saldoVES: number, faltanteUSD: number, faltanteVES: number }
  async verificarFondosVuelto(montoUSD: number, montoVES: number, tasaCambio: number) {
    const caja = await asegurarCajaPrincipal(prisma);
    const saldoUSD = Number(caja.Saldo_Actual);
    
    // Convertir todo a USD para comparación: saldoVES / tasa = saldo en USD
    const saldoEquivalenteUSD = montoVES > 0 && tasaCambio > 0 ? montoVES / tasaCambio : 0;
    const totalRequeridoUSD = montoUSD + saldoEquivalenteUSD;
    
    const puedeProcesar = saldoUSD >= totalRequeridoUSD;
    const faltanteUSD = puedeProcesar ? 0 : totalRequeridoUSD - saldoUSD;
    const faltanteVES = faltanteUSD * tasaCambio;
    
    return {
      puedeProcesar,
      saldoUSD,
      saldoVES: saldoUSD * tasaCambio,
      faltanteUSD,
      faltanteVES,
    };
  },

  async calcularPatrimonioOperativo() {
    // El patrimonio es una agregacion escalar. No tiene sentido traer miles
    // de productos a Node solo para sumar Stock x Costo_Promedio.
    // La formula contable se mantiene identica, pero la suma la ejecuta MySQL.
    const [caja, inventarioRaw] = await Promise.all([
      asegurarCajaPrincipal(prisma),
      prisma.$queryRaw<{ valorInventario: string | number | null }>`
        SELECT COALESCE(
          SUM(Stock_Actual * COALESCE(Costo_Promedio, 0)),
          0
        ) AS valorInventario
        FROM productos
      `,
    ]);

    const valorInventario = Number(inventarioRaw.valorInventario ?? 0);
    const saldoCaja = Number(caja.Saldo_Actual);

    return {
      caja: saldoCaja,
      inventario: valorInventario,
      patrimonio: saldoCaja + valorInventario,
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

      const montoD4 = toD4(monto);
      if (montoD4 <= 0n) {
        throw new Error('Monto de abono inválido (debe ser mayor a $0.00)');
      }

      const caja = await exigirCajaAbierta(tx);

      // ── REGLA ANTI-DÉFICIT (Fondo de maniobra) ──────────────────────────
      // Nunca se permite que un abono deje la gaveta en negativo: el montante
      // debe estar cubierto por el saldo disponible en caja. El supervisor
      // debe inyectar fondo (Ingreso de Caja) antes de abonar.
      const saldoCajaD4 = toD4(caja.Saldo_Actual);
      if (montoD4 > saldoCajaD4) {
        throw new Error(
          `SALDO_INSUFICIENTE:El abono de $${aDecimal(montoD4)} excede el saldo ` +
          `disponible en caja ($${aDecimal(saldoCajaD4)}). Inyecte un Ingreso ` +
          `de Caja (supervisor) antes de abonar, o reduzca el monto.`
        );
      }

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
          Monto_USD: aDecimal(montoD4),
          Origen_Tipo: 'cxp',
          Origen_ID: cxpId,
        },
      });

      await tx.caja.update({
        where: { Caja_ID: caja.Caja_ID },
        data: { Saldo_Actual: { decrement: aDecimal(montoD4) } },
      });

      return cxpActualizada;
    });
  },
};

