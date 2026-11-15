-- =============================================================================
-- IDOM ADA · Migración 0021 · Dos clases de foto en los contenedores
--
-- Decisión del 15/11/2026: un contenedor tiene
--   * fotos del contenedor (GENERAL): para reconocer el propio contenedor; la
--     primera es la principal y es la que sale en miniatura;
--   * fotos del contenido (CONTENTS): lo que hay dentro. La más reciente es la
--     actual; las anteriores quedan como historial. Cada vez que entra o sale
--     contenido, la aplicación pregunta si se quiere actualizar.
-- Las demás entidades solo tienen fotos GENERAL.
-- =============================================================================

ALTER TABLE photo ADD COLUMN purpose text NOT NULL DEFAULT 'GENERAL';
ALTER TABLE photo ADD CONSTRAINT photo_purpose_chk CHECK (purpose IN ('GENERAL', 'CONTENTS'));
ALTER TABLE photo ADD CONSTRAINT photo_contents_only_container_chk CHECK (purpose = 'GENERAL' OR entity_type = 'container');
