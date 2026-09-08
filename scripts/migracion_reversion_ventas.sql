-- ============================================================================
-- MIGRACIÓN P0.4 — Reversión de Venta (Notas de Crédito SENIAT)
-- Ferretería Adrialga, C.A.
-- ----------------------------------------------------------------------------
-- Añade soporte para Notas de Crédito en la tabla `facturas`:
--   - Tipo_Documento       : FACTURA | NOTA_CREDITO
--   - Factura_Afectada_ID  : Factura_ID de la venta original (solo NC)
-- También inserta el contador de serie propio para NC (CTRL-NC-<anio>).
-- EJECUTAR EN CADA AMBIENTE (local + Railway) antes de desplegar el backend.
-- ============================================================================

ALTER TABLE facturas
  ADD COLUMN Tipo_Documento      VARCHAR(20) NULL AFTER Estatus,
  ADD COLUMN Factura_Afectada_ID INT NULL AFTER Tipo_Documento,
  ADD INDEX  IDX_Facturas_TipoDoc (Tipo_Documento),
  ADD INDEX  IDX_Facturas_Afectada (Factura_Afectada_ID);

-- Backfill: las facturas existentes son facturas regulares.
UPDATE facturas SET Tipo_Documento = 'FACTURA' WHERE Tipo_Documento IS NULL;

-- Contador de serie independiente para Notas de Crédito (año en curso).
-- El controlador usa upsert+increment por año (CTRL-NC-<anio>), por lo que esta
-- línea es solo la semilla declarativa del año actual.
INSERT INTO contadores_fiscales (Clave, Valor) VALUES ('CTRL-NC-2026', 0)
  ON DUPLICATE KEY UPDATE Clave = Clave;