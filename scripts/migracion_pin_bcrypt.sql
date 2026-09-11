-- ============================================================================
-- MIGRACIÓN: PIN DE SUPERVISOR CON HASH BCRYPT — Ferretería Adrialga, C.A.
-- ----------------------------------------------------------------------------
-- Amplía la columna PIN_Operaciones de VarChar(10) a VarChar(60) para
-- almacenar el hash bcrypt ($2a$10$..., 60 caracteres) en lugar de texto
-- plano. Idempotente: segura para re-ejecutar en LOCAL y RAILWAY.
--
-- IMPORTANTE: tras aplicar esta migración, ejecutar `npx prisma db push` y
-- `npx prisma generate`, luego re-ejecutar el seed (`npm run seed`) para
-- re-hashear el PIN de operación del supervisor. Los PIN planos heredados
-- quedan funcionalmente ignorados por el validador bcrypt (prefijo $2).
-- ============================================================================

ALTER TABLE usuarios MODIFY PIN_Operaciones VARCHAR(60) NULL;
