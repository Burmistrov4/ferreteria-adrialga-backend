-- scripts/migracion_tasas_bcv.sql
-- Histórico de la tasa oficial BCV (una fila por jornada).
-- Ejecutar UNA VEZ en producción (Railway / MySQL):
--   mysql -h <host> -u <user> -p <db> < scripts/migracion_tasas_bcv.sql
-- O vía panel de Railway → MySQL → query console.
-- Es idempotente: puede re-ejecutarse sin daño.

CREATE TABLE IF NOT EXISTS `tasas_bcv` (
  `Tasa_ID` INT AUTO_INCREMENT PRIMARY KEY,
  `Fecha` DATE NOT NULL,
  `Tasa` DECIMAL(12,4) NOT NULL,
  `Origen` VARCHAR(100) NOT NULL DEFAULT 'Banco Central de Venezuela',
  `Fecha_Registro` TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `UQ_TasasBcv_Fecha` (`Fecha`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Semilla: OPCIONAL / innecesaria. El controlador de tasa tiene una cadena
-- de respaldo en cascada: scraper en vivo → última fila de tasas_bcv →
-- última Tasa_Cambio histórica de facturas (nivel 3) → 503. Con facturas
-- reales en la BD el sistema se autoabastece sin semilla manual.
-- Si aún así deseas precargar, descomenta y ajusta el valor:
-- INSERT INTO `tasas_bcv` (`Fecha`, `Tasa`, `Origen`)
-- VALUES (CURDATE(), 36.5000, 'Semilla manual (verificar en bcv.org.ve)')
-- ON DUPLICATE KEY UPDATE `Tasa` = VALUES(`Tasa`);