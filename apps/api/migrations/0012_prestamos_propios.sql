-- =============================================================================
-- IDOM ADA · Migración 0012 · Cada uno ve sus préstamos
--
-- Decisión del 15/11/2026: en «Préstamos», cada persona ve solo lo que tiene
-- prestado. Los únicos que ven todos los préstamos son los responsables de
-- almacén. (Devolver en nombre de otro sigue siendo «loan.manage».)
-- =============================================================================

INSERT INTO permission (code, description) VALUES
    ('loan.read_all', 'Ver los préstamos de todos los usuarios');

INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id FROM role r, permission p
 WHERE r.code = 'RESP_ALMACEN' AND p.code = 'loan.read_all';
