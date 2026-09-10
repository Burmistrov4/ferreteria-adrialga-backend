-- ============================================================================
-- MIGRACIÓN DE PRECISIÓN MONETARIA — DECIMAL(18,6)
-- Ferretería Adrialga, C.A.
-- ----------------------------------------------------------------------------
-- Amplía todos los campos monetarios de Integer-as-money a DECIMAL(18,6).
-- Se ejecuta con 'npx prisma db push' (ampliación NO destructiva, retrocompatible
-- con el motor BigInt a 4 decimales: al entrar los valores siguen escalando ×1e4
-- y MySQL redondea a la escala definida al almacenar).
-- Aplicable en LOCAL y RAILWAY (idempotente).
-- ============================================================================

ALTER TABLE productos              MODIFY Precio_Venta DECIMAL(18,6) NOT NULL DEFAULT 0.000000;
ALTER TABLE productos              MODIFY Costo_Promedio DECIMAL(18,6) NOT NULL DEFAULT 0.000000;

ALTER TABLE facturas               MODIFY Subtotal DECIMAL(18,6) NOT NULL DEFAULT 0.000000;
ALTER TABLE facturas               MODIFY Total_IVA DECIMAL(18,6) NOT NULL DEFAULT 0.000000;
ALTER TABLE facturas               MODIFY Total_General DECIMAL(18,6) NOT NULL DEFAULT 0.000000;
ALTER TABLE facturas               MODIFY Tasa_Cambio DECIMAL(18,6) NOT NULL DEFAULT 1.000000;
ALTER TABLE facturas               MODIFY Monto_IGTF DECIMAL(18,6) NOT NULL DEFAULT 0.000000;

ALTER TABLE detalle_facturas       MODIFY Precio_Unitario DECIMAL(18,6) NOT NULL DEFAULT 0.000000;
ALTER TABLE detalle_facturas       MODIFY Costo_Unitario_Historico DECIMAL(18,6) NOT NULL DEFAULT 0.000000;
ALTER TABLE detalle_facturas       MODIFY Subtotal DECIMAL(18,6) NULL;

ALTER TABLE notas_entrega_entrada  MODIFY Total_Costo DECIMAL(18,6) NOT NULL DEFAULT 0.000000;
ALTER TABLE detalle_notas_entrega  MODIFY Costo_Unitario DECIMAL(18,6) NOT NULL DEFAULT 0.000000;
ALTER TABLE detalle_notas_entrega  MODIFY Subtotal_Costo DECIMAL(18,6) NULL;

ALTER TABLE pagos                  MODIFY Monto DECIMAL(18,6) NOT NULL;
ALTER TABLE pagos                  MODIFY Tasa_Cambio DECIMAL(18,6) NULL;

ALTER TABLE caja                   MODIFY Saldo_Inicial DECIMAL(18,6) NOT NULL DEFAULT 0.000000;
ALTER TABLE caja                   MODIFY Saldo_Actual DECIMAL(18,6) NOT NULL DEFAULT 0.000000;

ALTER TABLE movimientos_caja       MODIFY Monto_USD DECIMAL(18,6) NOT NULL;
ALTER TABLE movimientos_caja       MODIFY Tasa_Cambio DECIMAL(18,6) NULL;

ALTER TABLE cuentas_por_pagar      MODIFY Monto_Total DECIMAL(18,6) NOT NULL;
ALTER TABLE cuentas_por_pagar      MODIFY Monto_Pagado DECIMAL(18,6) NOT NULL DEFAULT 0.000000;
ALTER TABLE cuentas_por_pagar      MODIFY Saldo DECIMAL(18,6) NOT NULL;

ALTER TABLE tasas_bcv              MODIFY Tasa DECIMAL(18,6) NOT NULL;