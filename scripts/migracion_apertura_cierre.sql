-- =====================================================================
-- Migración: Apertura / Cierre de Caja (arqueo por turno)
-- Motor: MySQL / MariaDB (backend Adrialga)
--
-- Aplica los campos de control de turno al modelo `caja`:
--   - Estado:       ABIERTA | CERRADA (estado del turno actual)
--   - Fecha_Cierre: cuándo se cerró/arqueó el turno (NULL mientras siga abierto)
--
-- Uso (una sola vez):
--   mysql -u <user> -p <database> < scripts/migracion_apertura_cierre.sql
-- =====================================================================

ALTER TABLE `caja`
  ADD COLUMN `Estado` VARCHAR(20) NOT NULL DEFAULT 'ABIERTA' AFTER `Fecha_Apertura`,
  ADD COLUMN `Fecha_Cierre` TIMESTAMP NULL DEFAULT NULL AFTER `Estado`;

-- Las cajas ya existentes que estén inactivas (anteriormente cerradas) se
-- marcaron como ABIERTA por el DEFAUTL; corregimos su estado para que refleje
-- su condición real (inactiva => CERRADA) y no queden inconsistencias.
UPDATE `caja`
SET `Estado` = 'CERRADA'
WHERE `Activa` = 0;

-- Verificación sugerida:
--   SELECT Caja_ID, Nombre, Activa, Estado, Saldo_Actual, Fecha_Apertura, Fecha_Cierre
--   FROM caja ORDER BY Caja_ID DESC;