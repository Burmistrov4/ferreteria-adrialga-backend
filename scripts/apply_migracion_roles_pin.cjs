// scripts/apply_migracion_roles_pin.cjs
// Migración de Roles + PIN de Operación (Autorización en Caliente).
//  * usuarios.PIN_Operaciones (VARCHAR 10)
//  * usuarios.Rol → ENUM('CAJERO','SUPERVISOR','ADMIN') (normaliza a mayúsculas)
//  * facturas.Autorizado_Por_ID + FK → usuarios
//  * seed de un usuario SUPERVISOR por defecto (PIN '1234')
// Idempotente (duplicates → SKIP).
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const guard = require('./qa_guard.cjs');
{
  if (!process.env.DATABASE_URL) {
    try { require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') }); } catch {}
  }
  const _guardUrl = process.env.DATABASE_URL || '';
  if (!_guardUrl) {
    console.error('ABORTADO: DATABASE_URL no está definida (ni en entorno ni en .env).');
    process.exit(3);
  }
  const _guardV = guard.validarHostLocal(_guardUrl);
  if (!_guardV.ok) {
    console.error('ABORTADO: destino de base de datos no permitido (' + guard.sanitizar(_guardUrl) + '): ' + _guardV.error);
    process.exit(3);
  }
}
const prisma = new PrismaClient();

const hashSupervisorPass = bcrypt.hashSync('supervisor', 10);

const SENTENCIAS = [
  // 1. Columnas de PIN
  "ALTER TABLE `usuarios` ADD COLUMN `PIN_Operaciones` VARCHAR(10) NULL AFTER `Rol`",
  // 2. Normalizar rol (preexistente 'Cajero'/'Admin' no es válido en el ENUM)
  "UPDATE `usuarios` SET `Rol` = UPPER(TRIM(`Rol`))",
  // 3. Cambiar tipo de columna a ENUM
  "ALTER TABLE `usuarios` MODIFY `Rol` ENUM('CAJERO','SUPERVISOR','ADMIN') NOT NULL DEFAULT 'CAJERO'",
  // 4. Autoriza-Por en facturas (columna + índice + FK)
  "ALTER TABLE `facturas` ADD COLUMN `Autorizado_Por_ID` INT NULL AFTER `Usuario_ID`",
  "ALTER TABLE `facturas` ADD INDEX `IDX_Facturas_Autorizado` (`Autorizado_Por_ID`)",
  "ALTER TABLE `facturas` ADD CONSTRAINT `FK_Facturas_AutorizadoPor` FOREIGN KEY (`Autorizado_Por_ID`) REFERENCES `usuarios`(`Usuario_ID`)",
];

async function main() {
  for (const s of SENTENCIAS) {
    const etiqueta = s.replace(/\s+/g, ' ').slice(0, 62) + '…';
    try {
      await prisma.$executeRawUnsafe(s);
      console.log(`OK    ${etiqueta}`);
    } catch (e) {
      const msg = String(e?.message || e);
      if (/Duplicate|already exists|Duplicate column name|Duplicate entry|Key.*already/i.test(msg)) {
        console.log(`SKIP  ${etiqueta} (ya aplicado)`);
      } else {
        throw e;
      }
    }
  }

  // Seed del SUPERVISOR por defecto (PIN '1234') si no existe ningún supervisor/admin con PIN.
  const count = await prisma.$queryRawUnsafe(
    "SELECT COUNT(*) AS n FROM `usuarios` WHERE `Rol` IN ('SUPERVISOR','ADMIN') AND `PIN_Operaciones` IS NOT NULL"
  );
  const n = Number(count[0].n ?? 0);
  if (n === 0) {
    await prisma.$executeRawUnsafe(
      "INSERT INTO `usuarios` (`Credencial`,`Nombre`,`Password`,`Rol`,`PIN_Operaciones`,`Activo`) VALUES (?,?,?,?,?,?)",
      'supervisor', 'Supervisor de Caja', hashSupervisorPass, 'SUPERVISOR', '1234', 1
    );
    console.log('OK    Seed SUPERVISOR por defecto (PIN 1234)');
  } else {
    console.log('SKIP  Ya existe (al menos) un SUPERVISOR/ADMIN con PIN');
  }

  console.log('Migración Roles + PIN aplicada/verificada.');
}

main()
  .catch((e) => { console.error('FALLO:', e?.message || e); process.exit(1); })
  .finally(() => prisma.$disconnect());