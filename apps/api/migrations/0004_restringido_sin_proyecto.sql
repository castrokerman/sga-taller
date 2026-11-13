-- =============================================================================
-- SGA Taller · Migración 0004 · Material restringido sin proyecto
--
-- Añade una cuarta situación para el stock:
--
--   1. Sin asignación ............................ uso genérico del taller
--   2. Asignado a un proyecto como FREE .......... libre, proyecto informativo
--   3. Asignado a un proyecto como RESTRICTED .... autoriza el proyecto
--   4. RESTRICTED sin proyecto (NUEVO) ........... autoriza el responsable
--                                                  designado en la asignación
--
-- En el caso 4 no hay proyecto que diga quién autoriza, así que la asignación
-- debe nombrar obligatoriamente a un responsable.
-- =============================================================================

-- La asignación puede no tener proyecto.
ALTER TABLE stock_allocation ALTER COLUMN project_id DROP NOT NULL;

-- Sin proyecto solo tiene sentido si es restringida y tiene responsable:
-- el material libre sin proyecto es, simplemente, stock sin asignar.
ALTER TABLE stock_allocation ADD CONSTRAINT stock_allocation_no_project_chk CHECK (
    project_id IS NOT NULL
    OR (availability = 'RESTRICTED' AND responsible_user_id IS NOT NULL)
);

-- Una sola asignación por saldo, proyecto y disponibilidad, también cuando no hay proyecto.
ALTER TABLE stock_allocation DROP CONSTRAINT stock_allocation_stock_balance_id_project_id_availability_key;
ALTER TABLE stock_allocation ADD CONSTRAINT stock_allocation_uq
    UNIQUE NULLS NOT DISTINCT (stock_balance_id, project_id, availability);

-- La solicitud de retirada puede no tener proyecto.
ALTER TABLE withdrawal_request ALTER COLUMN project_id DROP NOT NULL;

-- La solicitud sigue ligada a la asignación, con o sin proyecto.
CREATE OR REPLACE FUNCTION sga_withdrawal_request_matches_allocation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    a stock_allocation%ROWTYPE;
    b stock_balance%ROWTYPE;
BEGIN
    SELECT * INTO a FROM stock_allocation WHERE id = NEW.stock_allocation_id;
    SELECT * INTO b FROM stock_balance WHERE id = a.stock_balance_id;

    IF a.project_id IS DISTINCT FROM NEW.project_id
       OR b.material_id <> NEW.material_id
       OR b.lot_id IS DISTINCT FROM NEW.lot_id
       OR b.container_id IS DISTINCT FROM NEW.container_id
       OR b.location_id IS DISTINCT FROM NEW.location_id THEN
        RAISE EXCEPTION 'La solicitud no coincide con la asignación de stock indicada'
            USING ERRCODE = 'SG012';
    END IF;
    RETURN NEW;
END $$;

-- Quién puede decidir:
--   * con proyecto: el responsable o un autorizador del proyecto (como antes);
--   * sin proyecto: el responsable designado en la asignación.
-- Nadie aprueba su propia solicitud; la excepción por política solo existe en proyectos.
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

        IF NEW.authorizer_id IS DISTINCT FROM v_responsible THEN
            RAISE EXCEPTION 'Solo el responsable designado puede autorizar este material restringido'
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
