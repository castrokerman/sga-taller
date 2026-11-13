-- =============================================================================
-- SGA Taller · Migración 0005 · Autorización del material restringido sin proyecto
--
-- Decisión del 13/11/2026: el material restringido que no pertenece a ningún
-- proyecto lo puede autorizar
--   * la persona designada en la asignación, si la hay, y además
--   * cualquier usuario con el permiso "restricted.authorize_general",
--     que tienen por defecto los responsables de almacén y los administradores.
--
-- Es una excepción acotada: el material restringido de un proyecto lo sigue
-- autorizando únicamente el responsable o un autorizador de ese proyecto.
-- Nadie puede aprobar su propia solicitud.
-- =============================================================================

INSERT INTO permission (code, description) VALUES
    ('restricted.authorize_general', 'Autorizar retiradas de material restringido que no pertenece a ningún proyecto');

INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id
  FROM role r, permission p
 WHERE r.code IN ('RESP_ALMACEN', 'ADMIN_TECNICO')
   AND p.code = 'restricted.authorize_general';

-- La persona designada pasa a ser opcional: sin ella, autorizan quienes tengan el permiso.
ALTER TABLE stock_allocation DROP CONSTRAINT stock_allocation_no_project_chk;
ALTER TABLE stock_allocation ADD CONSTRAINT stock_allocation_no_project_chk CHECK (
    project_id IS NOT NULL OR availability = 'RESTRICTED'
);

CREATE OR REPLACE FUNCTION sga_withdrawal_authorization_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    r withdrawal_request%ROWTYPE;
    p project%ROWTYPE;
    v_responsible uuid;
BEGIN
    SELECT * INTO r FROM withdrawal_request WHERE id = NEW.request_id;

    IF r.project_id IS NOT NULL THEN
        SELECT * INTO p FROM project WHERE id = r.project_id;

        IF NEW.authorizer_id <> p.responsible_user_id AND NOT EXISTS (
            SELECT 1 FROM project_authorizer
             WHERE project_id = p.id AND user_id = NEW.authorizer_id
        ) THEN
            RAISE EXCEPTION 'El usuario no es autorizador del proyecto %', p.code USING ERRCODE = 'SG009';
        END IF;

        IF NEW.authorizer_id = r.requester_id AND NOT p.allow_self_approval THEN
            RAISE EXCEPTION 'Un usuario no puede aprobar su propia solicitud' USING ERRCODE = 'SG008';
        END IF;
    ELSE
        SELECT responsible_user_id INTO v_responsible FROM stock_allocation WHERE id = r.stock_allocation_id;

        IF NEW.authorizer_id IS DISTINCT FROM v_responsible AND NOT EXISTS (
            SELECT 1
              FROM app_user u
              JOIN user_role ur ON ur.user_id = u.id
              JOIN role_permission rp ON rp.role_id = ur.role_id
              JOIN permission pe ON pe.id = rp.permission_id
             WHERE u.id = NEW.authorizer_id AND u.active
               AND pe.code = 'restricted.authorize_general'
        ) THEN
            RAISE EXCEPTION 'El usuario no puede autorizar material restringido sin proyecto'
                USING ERRCODE = 'SG009';
        END IF;

        IF NEW.authorizer_id = r.requester_id THEN
            RAISE EXCEPTION 'Un usuario no puede aprobar su propia solicitud' USING ERRCODE = 'SG008';
        END IF;
    END IF;

    IF NEW.decision = 'APPROVED' AND NEW.quantity_authorized <> r.quantity_requested THEN
        RAISE EXCEPTION 'Una aprobación total debe autorizar la cantidad solicitada' USING ERRCODE = 'SG010';
    END IF;
    IF NEW.decision = 'PARTIALLY_APPROVED' AND NEW.quantity_authorized >= r.quantity_requested THEN
        RAISE EXCEPTION 'Una aprobación parcial debe autorizar menos de lo solicitado' USING ERRCODE = 'SG010';
    END IF;

    RETURN NEW;
END $$;

-- La capacidad máxima de una ubicación se mide, por ahora, en número de
-- contenedores colocados directamente en ella.
COMMENT ON COLUMN storage_location.max_capacity IS
    'Número máximo de contenedores colocados directamente en la ubicación. Superarlo avisa, no bloquea (parámetro capacity.policy).';
