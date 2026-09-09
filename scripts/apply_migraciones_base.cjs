// scripts/apply_migraciones_base.cjs
// Crea las tablas de soporte (contadores_fiscales, tasas_bcv) si faltan.
// Idempotente (CREATE TABLE IF NOT EXISTS / seed con ON DUPLICATE).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const SENTENCIAS = [
  "CREATE TABLE IF NOT EXISTS `contadores_fiscales` (" +
    "`Id` INT AUTO_INCREMENT PRIMARY KEY, " +
    "`Clave` VARCHAR(60) NOT NULL, " +
    "`Valor` INT NOT NULL DEFAULT 0, " +
    "UNIQUE KEY `UQ_Contadores_Clave` (`Clave`)" +
    ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",

  "CREATE TABLE IF NOT EXISTS `tasas_bcv` (" +
    "`Tasa_ID` INT AUTO_INCREMENT PRIMARY KEY, " +
    "`Fecha` DATE NOT NULL, " +
    "`Tasa` DECIMAL(12,4) NOT NULL, " +
    "`Origen` VARCHAR(100) NOT NULL DEFAULT 'Banco Central de Venezuela', " +
    "`Fecha_Registro` TIMESTAMP(0) NOT NULL DEFAULT CURRENT_TIMESTAMP, " +
    "UNIQUE KEY `UQ_TasasBcv_Fecha` (`Fecha`)" +
    ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci",

  // Semilla del contador de numeración fiscal normal (se deduce del mayor).
  "INSERT INTO `contadores_fiscales` (`Clave`, `Valor`) " +
    "SELECT CONCAT('CTRL-VENTAS-', YEAR(CURDATE())), " +
    "  COALESCE(MAX(CAST(SUBSTRING_INDEX(`Numero_Control`, '-', -1) AS UNSIGNED)), 0) + 1 " +
    "FROM `facturas` " +
    "WHERE `Numero_Control` REGEXP '^[0-9]{2}-[0-9]{2}-[0-9]{8}$' " +
    "ON DUPLICATE KEY UPDATE `Valor` = VALUES(`Valor`)",
];

async function main() {
  for (const s of SENTENCIAS) {
    const etiqueta = s.replace(/\s+/g, ' ').slice(0, 60) + '…';
    try {
      await prisma.$executeRawUnsafe(s);
      console.log(`OK    ${etiqueta}`);
    } catch (e) {
      const msg = String(e?.message || e);
      if (/Duplicate|already exists/i.test(msg)) {
        console.log(`SKIP  ${etiqueta} (ya existe)`);
      } else {
        throw e;
      }
    }
  }
  console.log('Tablas de soporte (contadores_fiscales, tasas_bcv) verificadas.');
}

main()
  .catch((e) => { console.error('FALLO:', e?.message || e); process.exit(1); })
  .finally(() => prisma.$disconnect());