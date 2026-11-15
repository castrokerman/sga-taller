-- =============================================================================
-- IDOM ADA · Migración 0020 · Descripción del contenido de un contenedor
--
-- Decisión del 15/11/2026: además de la descripción del contenedor, una
-- descripción libre de lo que lleva dentro («tornillería M6», «retales de
-- chapa»). Se ve como una nube más en el árbol y en las listas.
-- =============================================================================

ALTER TABLE container ADD COLUMN content_description text;
ALTER TABLE container ADD CONSTRAINT container_content_description_len
  CHECK (content_description IS NULL OR length(content_description) <= 300);
