-- =============================================================================
-- IDOM ADA · Migración 0022 · Eliminar contenidos
--
-- Decisión del 15/11/2026: el administrador técnico puede eliminar contenidos
-- desde «Editar en tabla», siempre con confirmación.
--   * Si no tiene historial, se borra del todo.
--   * Si tiene historial (movimientos, préstamos, recepciones), desaparece de
--     listas, buscador y escáner, pero su historial se conserva (deleted_at).
--   * Si queda algo guardado o prestado, no se puede: hay que retirarlo antes.
-- =============================================================================

ALTER TABLE material ADD COLUMN deleted_at timestamptz;
ALTER TABLE material ADD COLUMN deleted_by uuid REFERENCES app_user(id);

INSERT INTO permission (code, description) VALUES
    ('material.delete', 'Eliminar contenidos');
INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id FROM role r, permission p WHERE r.code = 'ADMIN_TECNICO' AND p.code = 'material.delete';
