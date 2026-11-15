-- =============================================================================
-- IDOM ADA · Migración 0013 · Proyectos, sus responsables y sus miembros
--
-- Decisiones del 15/11/2026:
--   * Los proyectos los crean y editan los responsables de almacén.
--   * Un proyecto puede tener varios responsables, y una persona puede ser
--     responsable de varios proyectos. También puede haber miembros, que
--     quedan asociados al proyecto pero no ven todo.
--   * Solo los responsables del proyecto (y los responsables de almacén) ven
--     todo lo del proyecto: sus contenedores y lo que hay dentro, sus
--     recepciones, sus préstamos y sus movimientos.
--   * Lo que está en un contenedor del proyecto queda reservado: solo sus
--     responsables y los responsables de almacén pueden sacarlo, trasladarlo
--     o prestarlo. Las autorizaciones (pedir permiso) llegarán más adelante.
--   * project.responsible_user_id se mantiene como responsable principal
--     (el primero de la lista), porque lo usa la parte de autorizaciones.
-- =============================================================================

CREATE TABLE project_member (
    project_id uuid NOT NULL REFERENCES project (id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES app_user (id),
    role       text NOT NULL DEFAULT 'RESPONSIBLE',
    position   integer NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, user_id),
    CONSTRAINT project_member_role_chk CHECK (role IN ('RESPONSIBLE', 'MEMBER'))
);
CREATE INDEX project_member_user_idx ON project_member (user_id, role);

-- Los proyectos que ya hubiera: su responsable pasa a la lista.
INSERT INTO project_member (project_id, user_id, role)
SELECT id, responsible_user_id, 'RESPONSIBLE' FROM project
ON CONFLICT DO NOTHING;

ALTER TABLE project ADD COLUMN description text;

-- Un contenedor puede ser de un proyecto; lo que hay dentro queda reservado.
ALTER TABLE container ADD COLUMN project_id uuid REFERENCES project (id);
CREATE INDEX container_project_idx ON container (project_id) WHERE project_id IS NOT NULL;

-- La recepción se puede dirigir a un proyecto (avisa a todos sus responsables).
ALTER TABLE inbound_item ADD COLUMN project_id uuid REFERENCES project (id);
CREATE INDEX inbound_project_idx ON inbound_item (project_id) WHERE project_id IS NOT NULL;

-- Crear y editar proyectos: responsables de almacén.
DELETE FROM role_permission
 WHERE permission_id = (SELECT id FROM permission WHERE code = 'project.manage')
   AND role_id IN (SELECT id FROM role WHERE code IN ('RESP_PROYECTO', 'ADMIN_TECNICO'));
INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id FROM role r, permission p
 WHERE r.code = 'RESP_ALMACEN' AND p.code = 'project.manage'
ON CONFLICT DO NOTHING;
UPDATE permission SET description = 'Crear y editar proyectos, sus responsables y miembros; ver y sacar lo reservado de cualquier proyecto'
 WHERE code = 'project.manage';
