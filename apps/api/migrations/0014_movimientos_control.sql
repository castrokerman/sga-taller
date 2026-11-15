-- =============================================================================
-- IDOM ADA · Migración 0014 · La pantalla de movimientos, solo para control
--
-- Decisión del 15/11/2026: la vista general de movimientos de todo el almacén
-- la ven solo los responsables de almacén. El historial de cada contenedor,
-- ubicación o contenido sigue viéndose en su ficha.
-- =============================================================================

INSERT INTO permission (code, description) VALUES
    ('movement.read_all', 'Ver los movimientos de todo el almacén');

INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id FROM role r, permission p
 WHERE r.code = 'RESP_ALMACEN' AND p.code = 'movement.read_all';
