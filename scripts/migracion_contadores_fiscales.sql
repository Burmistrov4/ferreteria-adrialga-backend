-- scripts/migracion_contadores_fiscales.sql
-- Contadores secuenciales para numeración fiscal (número de control SENIAT).
-- Ejecutar UNA VEZ en producción (Railway / MySQL):
CREATE TABLE IF NOT EXISTS `contadores_fiscales` (
  `Id` INT AUTO_INCREMENT PRIMARY KEY,
  `Clave` VARCHAR(60) NOT NULL,
  `Valor` INT NOT NULL DEFAULT 0,
  UNIQUE KEY `UQ_Contadores_Clave` (`Clave`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Opcional: arrancar la serie en el número siguiente al último usado.
-- El formato generado es 00-00-XXXXXXXX; se deduce del mayor existente.
INSERT INTO `contadores_fiscales` (`Clave`, `Valor`)
SELECT CONCAT('CTRL-VENTAS-', YEAR(CURDATE())),
       COALESCE(MAX(CAST(SUBSTRING_INDEX(`Numero_Control`, '-', -1) AS UNSIGNED)), 0) + 1
FROM `facturas`
WHERE `Numero_Control` REGEXP '^[0-9]{2}-[0-9]{2}-[0-9]{8}$'
ON DUPLICATE KEY UPDATE `Valor` = VALUES(`Valor`);