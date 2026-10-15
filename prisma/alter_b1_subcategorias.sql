-- ============================================================
-- B1: Migración de esquema para subcategorías auto-referenciales
--     + trazabilidad del catálogo EPA (scraper automotriz)
-- Aplicado con: prisma db execute --file prisma/alter_b1_subcategorias.sql
-- ============================================================

-- 1) categorias: columna padre auto-referencial + FK a sí misma
ALTER TABLE categorias
  ADD COLUMN Categoria_Padre_ID INT NULL,
  ADD CONSTRAINT FK_Cat_Padre FOREIGN KEY (Categoria_Padre_ID)
    REFERENCES categorias (Categoria_ID);

-- 2) productos: trazabilidad EPA
ALTER TABLE productos
  ADD COLUMN Codigo_EPA     VARCHAR(50)  NULL,
  ADD COLUMN Marca          VARCHAR(100) NULL,
  ADD COLUMN Precio_Ref_USD DECIMAL(18,6) NULL,
  ADD UNIQUE KEY UQ_Codigo_EPA (Codigo_EPA);
