-- =============================================================================
-- IDOM ADA · Migración 0024 · Foto del albarán
--
-- Decisión del 22/11/2026: al registrar una entrada se puede hacer una foto
-- del albarán o del pedido. Queda unida al movimiento de esa entrada y se ve
-- en el historial y en «Movimientos».
-- =============================================================================

ALTER TABLE photo DROP CONSTRAINT photo_entity_chk;
ALTER TABLE photo ADD CONSTRAINT photo_entity_chk
    CHECK (entity_type IN ('location', 'container', 'material', 'inbound', 'movement'));
