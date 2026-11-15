-- =============================================================================
-- IDOM ADA · Migración 0017 · Borrar usuarios sin perder el historial
--
-- Decisión del 15/11/2026: se puede borrar un usuario. Desaparece de las
-- listas, no puede volver a entrar y su nombre de usuario queda libre, pero
-- su registro se conserva para que el historial (movimientos, comentarios,
-- recepciones, auditoría) siga diciendo quién hizo cada cosa.
-- =============================================================================

ALTER TABLE app_user
    ADD COLUMN deleted_at timestamptz,
    ADD COLUMN deleted_by uuid REFERENCES app_user (id);
