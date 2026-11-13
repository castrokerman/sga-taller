-- =============================================================================
-- SGA Taller · Migración 0002 · Reglas de integridad (funciones, triggers, vistas)
--
-- Estas reglas son la red de seguridad de la base de datos. La API valida lo
-- mismo antes, con mensajes más claros, pero aunque la API tuviera un error
-- la base de datos no aceptaría datos incoherentes.
--
-- Códigos de error propios (SQLSTATE), para que la API los traduzca:
--   SG001 ciclo en la jerarquía de ubicaciones
--   SG002 ciclo en la jerarquía de contenedores
--   SG003 lote obligatorio para este material
--   SG004 cantidad incoherente con el modo de control del material
--   SG005 el contenedor no está activo
--   SG006 las asignaciones superan el stock físico
--   SG007 las reservas superan la cantidad asignada
--   SG008 un usuario no puede aprobar su propia solicitud
--   SG009 el usuario no es autorizador del proyecto
--   SG010 cantidad autorizada incoherente con la decisión
--   SG011 registro inmutable (movimientos, autorizaciones, auditoría)
--   SG012 la solicitud no coincide con la asignación de stock
--   SG013 no se puede asignar material sin control de cantidad
--   SG014 el token QR no se puede modificar
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Jerarquías sin ciclos
-- -----------------------------------------------------------------------------

CREATE FUNCTION sga_storage_location_no_cycle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.parent_id IS NOT NULL AND EXISTS (
        WITH RECURSIVE up AS (
            SELECT id, parent_id FROM storage_location WHERE id = NEW.parent_id
            UNION ALL
            SELECT l.id, l.parent_id FROM storage_location l JOIN up ON l.id = up.parent_id
        )
        SELECT 1 FROM up WHERE id = NEW.id
    ) THEN
        RAISE EXCEPTION 'La ubicación % no puede colgar de una de sus descendientes', NEW.code
            USING ERRCODE = 'SG001';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER storage_location_no_cycle
    BEFORE INSERT OR UPDATE OF parent_id ON storage_location
    FOR EACH ROW EXECUTE FUNCTION sga_storage_location_no_cycle();

CREATE FUNCTION sga_container_no_cycle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.parent_container_id IS NOT NULL AND EXISTS (
        WITH RECURSIVE up AS (
            SELECT id, parent_container_id FROM container WHERE id = NEW.parent_container_id
            UNION ALL
            SELECT c.id, c.parent_container_id FROM container c JOIN up ON c.id = up.parent_container_id
        )
        SELECT 1 FROM up WHERE id = NEW.id
    ) THEN
        RAISE EXCEPTION 'El contenedor % no puede meterse dentro de uno de sus descendientes', NEW.code
            USING ERRCODE = 'SG002';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER container_no_cycle
    BEFORE INSERT OR UPDATE OF parent_container_id ON container
    FOR EACH ROW EXECUTE FUNCTION sga_container_no_cycle();

-- -----------------------------------------------------------------------------
-- El token QR es inmutable
-- -----------------------------------------------------------------------------

CREATE FUNCTION sga_qr_token_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.qr_token IS DISTINCT FROM OLD.qr_token THEN
        RAISE EXCEPTION 'El token QR no se puede modificar' USING ERRCODE = 'SG014';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER storage_location_qr_immutable BEFORE UPDATE OF qr_token ON storage_location
    FOR EACH ROW EXECUTE FUNCTION sga_qr_token_immutable();
CREATE TRIGGER container_qr_immutable BEFORE UPDATE OF qr_token ON container
    FOR EACH ROW EXECUTE FUNCTION sga_qr_token_immutable();
CREATE TRIGGER equipment_qr_immutable BEFORE UPDATE OF qr_token ON equipment
    FOR EACH ROW EXECUTE FUNCTION sga_qr_token_immutable();

-- -----------------------------------------------------------------------------
-- Reglas del stock físico
-- -----------------------------------------------------------------------------

CREATE FUNCTION sga_stock_balance_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    m material%ROWTYPE;
    c_status text;
BEGIN
    SELECT * INTO m FROM material WHERE id = NEW.material_id;

    IF m.lot_tracked AND NEW.lot_id IS NULL THEN
        RAISE EXCEPTION 'El material % exige lote', m.internal_ref USING ERRCODE = 'SG003';
    END IF;

    IF m.quantity_tracking = 'NOT_TRACKED' AND NEW.quantity IS NOT NULL THEN
        RAISE EXCEPTION 'El material % no lleva control de cantidad', m.internal_ref USING ERRCODE = 'SG004';
    END IF;
    IF m.quantity_tracking <> 'NOT_TRACKED' AND NEW.quantity IS NULL THEN
        RAISE EXCEPTION 'El material % exige cantidad', m.internal_ref USING ERRCODE = 'SG004';
    END IF;

    IF NEW.container_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.container_id IS DISTINCT FROM OLD.container_id) THEN
        SELECT status INTO c_status FROM container WHERE id = NEW.container_id;
        IF c_status <> 'ACTIVE' THEN
            RAISE EXCEPTION 'El contenedor de destino está retirado' USING ERRCODE = 'SG005';
        END IF;
    END IF;

    RETURN NEW;
END $$;

CREATE TRIGGER stock_balance_rules
    BEFORE INSERT OR UPDATE ON stock_balance
    FOR EACH ROW EXECUTE FUNCTION sga_stock_balance_rules();

-- -----------------------------------------------------------------------------
-- Las asignaciones nunca superan el físico
-- -----------------------------------------------------------------------------

CREATE FUNCTION sga_check_allocations(p_balance_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    v_qty   numeric;
    v_alloc numeric;
BEGIN
    -- Bloquea el saldo: dos operaciones simultáneas sobre el mismo stock se ponen en cola.
    SELECT quantity INTO v_qty FROM stock_balance WHERE id = p_balance_id FOR UPDATE;
    SELECT coalesce(sum(quantity), 0) INTO v_alloc FROM stock_allocation WHERE stock_balance_id = p_balance_id;

    IF v_alloc > 0 AND v_qty IS NULL THEN
        RAISE EXCEPTION 'No se puede asignar a proyecto un material sin control de cantidad'
            USING ERRCODE = 'SG013';
    END IF;
    IF v_alloc > coalesce(v_qty, 0) THEN
        RAISE EXCEPTION 'Las asignaciones (%) superan el stock físico (%)', v_alloc, v_qty
            USING ERRCODE = 'SG006';
    END IF;
END $$;

CREATE FUNCTION sga_allocation_within_balance() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM sga_check_allocations(NEW.stock_balance_id);
    RETURN NULL;
END $$;

CREATE TRIGGER stock_allocation_within_balance
    AFTER INSERT OR UPDATE OF quantity, stock_balance_id ON stock_allocation
    FOR EACH ROW EXECUTE FUNCTION sga_allocation_within_balance();

CREATE FUNCTION sga_balance_covers_allocations() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM sga_check_allocations(NEW.id);
    RETURN NULL;
END $$;

CREATE TRIGGER stock_balance_covers_allocations
    AFTER UPDATE OF quantity ON stock_balance
    FOR EACH ROW EXECUTE FUNCTION sga_balance_covers_allocations();

-- -----------------------------------------------------------------------------
-- Las reservas activas nunca superan la asignación
-- -----------------------------------------------------------------------------

CREATE FUNCTION sga_check_reservations(p_allocation_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    v_alloc    numeric;
    v_reserved numeric;
BEGIN
    SELECT quantity INTO v_alloc FROM stock_allocation WHERE id = p_allocation_id FOR UPDATE;
    SELECT coalesce(sum(quantity - quantity_consumed), 0) INTO v_reserved
      FROM stock_reservation
     WHERE stock_allocation_id = p_allocation_id AND status = 'ACTIVE';

    IF v_reserved > v_alloc THEN
        RAISE EXCEPTION 'Las reservas activas (%) superan la cantidad asignada (%)', v_reserved, v_alloc
            USING ERRCODE = 'SG007';
    END IF;
END $$;

CREATE FUNCTION sga_reservation_within_allocation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM sga_check_reservations(NEW.stock_allocation_id);
    RETURN NULL;
END $$;

CREATE TRIGGER stock_reservation_within_allocation
    AFTER INSERT OR UPDATE ON stock_reservation
    FOR EACH ROW EXECUTE FUNCTION sga_reservation_within_allocation();

CREATE FUNCTION sga_allocation_covers_reservations() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    PERFORM sga_check_reservations(NEW.id);
    RETURN NULL;
END $$;

CREATE TRIGGER stock_allocation_covers_reservations
    AFTER UPDATE OF quantity ON stock_allocation
    FOR EACH ROW EXECUTE FUNCTION sga_allocation_covers_reservations();

-- -----------------------------------------------------------------------------
-- Solicitudes y autorizaciones
-- -----------------------------------------------------------------------------

-- La solicitud queda ligada a material, lote, lugar y proyecto de la asignación.
CREATE FUNCTION sga_withdrawal_request_matches_allocation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    a stock_allocation%ROWTYPE;
    b stock_balance%ROWTYPE;
BEGIN
    SELECT * INTO a FROM stock_allocation WHERE id = NEW.stock_allocation_id;
    SELECT * INTO b FROM stock_balance WHERE id = a.stock_balance_id;

    IF a.project_id <> NEW.project_id
       OR b.material_id <> NEW.material_id
       OR b.lot_id IS DISTINCT FROM NEW.lot_id
       OR b.container_id IS DISTINCT FROM NEW.container_id
       OR b.location_id IS DISTINCT FROM NEW.location_id THEN
        RAISE EXCEPTION 'La solicitud no coincide con la asignación de stock indicada'
            USING ERRCODE = 'SG012';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER withdrawal_request_matches_allocation
    BEFORE INSERT ON withdrawal_request
    FOR EACH ROW EXECUTE FUNCTION sga_withdrawal_request_matches_allocation();

-- Quién puede decidir y con qué cantidades.
CREATE FUNCTION sga_withdrawal_authorization_rules() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    r withdrawal_request%ROWTYPE;
    p project%ROWTYPE;
BEGIN
    SELECT * INTO r FROM withdrawal_request WHERE id = NEW.request_id;
    SELECT * INTO p FROM project WHERE id = r.project_id;

    -- Ser administrador técnico no basta: hay que ser responsable o autorizador del proyecto.
    IF NEW.authorizer_id <> p.responsible_user_id AND NOT EXISTS (
        SELECT 1 FROM project_authorizer
         WHERE project_id = p.id AND user_id = NEW.authorizer_id
    ) THEN
        RAISE EXCEPTION 'El usuario no es autorizador del proyecto %', p.code USING ERRCODE = 'SG009';
    END IF;

    IF NEW.authorizer_id = r.requester_id AND NOT p.allow_self_approval THEN
        RAISE EXCEPTION 'Un usuario no puede aprobar su propia solicitud' USING ERRCODE = 'SG008';
    END IF;

    IF NEW.decision = 'APPROVED' AND NEW.quantity_authorized <> r.quantity_requested THEN
        RAISE EXCEPTION 'Una aprobación total debe autorizar la cantidad solicitada' USING ERRCODE = 'SG010';
    END IF;
    IF NEW.decision = 'PARTIALLY_APPROVED' AND NEW.quantity_authorized >= r.quantity_requested THEN
        RAISE EXCEPTION 'Una aprobación parcial debe autorizar menos de lo solicitado' USING ERRCODE = 'SG010';
    END IF;

    RETURN NEW;
END $$;

CREATE TRIGGER withdrawal_authorization_rules
    BEFORE INSERT ON withdrawal_authorization
    FOR EACH ROW EXECUTE FUNCTION sga_withdrawal_authorization_rules();

-- -----------------------------------------------------------------------------
-- Registros inmutables: no se editan ni se borran
-- -----------------------------------------------------------------------------

CREATE FUNCTION sga_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Los registros de % son inmutables: no se pueden modificar ni borrar', TG_TABLE_NAME
        USING ERRCODE = 'SG011';
END $$;

CREATE TRIGGER stock_movement_immutable BEFORE UPDATE OR DELETE ON stock_movement
    FOR EACH ROW EXECUTE FUNCTION sga_immutable();
CREATE TRIGGER stock_movement_no_truncate BEFORE TRUNCATE ON stock_movement
    FOR EACH STATEMENT EXECUTE FUNCTION sga_immutable();

CREATE TRIGGER stock_movement_line_immutable BEFORE UPDATE OR DELETE ON stock_movement_line
    FOR EACH ROW EXECUTE FUNCTION sga_immutable();
CREATE TRIGGER stock_movement_line_no_truncate BEFORE TRUNCATE ON stock_movement_line
    FOR EACH STATEMENT EXECUTE FUNCTION sga_immutable();

CREATE TRIGGER withdrawal_authorization_immutable BEFORE UPDATE OR DELETE ON withdrawal_authorization
    FOR EACH ROW EXECUTE FUNCTION sga_immutable();

CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION sga_immutable();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
    FOR EACH STATEMENT EXECUTE FUNCTION sga_immutable();

-- -----------------------------------------------------------------------------
-- Vistas
-- -----------------------------------------------------------------------------

-- Ubicación efectiva de cada contenedor: la del contenedor raíz de su cadena.
CREATE VIEW container_effective_location AS
WITH RECURSIVE up AS (
    SELECT id AS container_id, id AS current_id, parent_container_id, location_id, 0 AS depth
      FROM container
    UNION ALL
    SELECT up.container_id, c.id, c.parent_container_id, c.location_id, up.depth + 1
      FROM up JOIN container c ON c.id = up.parent_container_id
)
SELECT container_id,
       current_id  AS root_container_id,
       location_id AS location_id,
       depth
  FROM up
 WHERE parent_container_id IS NULL;

-- Contenido de los contenedores. Sustituye a la tabla container_content del
-- planteamiento inicial: es una consulta sobre stock_balance, no una segunda
-- fuente de verdad.
CREATE VIEW container_content AS
SELECT b.container_id,
       b.id            AS stock_balance_id,
       b.material_id,
       m.internal_ref,
       m.description,
       m.unit_code,
       m.quantity_tracking,
       b.lot_id,
       l.lot_code,
       b.quantity,
       b.needs_recount
  FROM stock_balance b
  JOIN material m ON m.id = b.material_id
  LEFT JOIN material_lot l ON l.id = b.lot_id
 WHERE b.container_id IS NOT NULL;

-- Disponibilidad de cada saldo: físico, restringido, reservado y libre.
CREATE VIEW stock_availability AS
SELECT b.id AS stock_balance_id,
       b.material_id,
       b.lot_id,
       b.container_id,
       b.location_id,
       b.quantity,
       coalesce(a.restricted, 0)                       AS quantity_restricted,
       coalesce(a.project_free, 0)                     AS quantity_project_free,
       coalesce(r.reserved, 0)                         AS quantity_reserved,
       b.quantity - coalesce(a.restricted, 0)          AS quantity_free
  FROM stock_balance b
  LEFT JOIN (
        SELECT stock_balance_id,
               sum(quantity) FILTER (WHERE availability = 'RESTRICTED') AS restricted,
               sum(quantity) FILTER (WHERE availability = 'FREE')       AS project_free
          FROM stock_allocation GROUP BY stock_balance_id
       ) a ON a.stock_balance_id = b.id
  LEFT JOIN (
        SELECT sa.stock_balance_id, sum(sr.quantity - sr.quantity_consumed) AS reserved
          FROM stock_reservation sr
          JOIN stock_allocation sa ON sa.id = sr.stock_allocation_id
         WHERE sr.status = 'ACTIVE'
         GROUP BY sa.stock_balance_id
       ) r ON r.stock_balance_id = b.id;

-- Documentos de lote visibles desde cada contenedor (también tras dividir un palet).
CREATE VIEW container_lot_document AS
SELECT DISTINCT b.container_id, b.lot_id, dr.document_id
  FROM stock_balance b
  JOIN document_relation dr ON dr.lot_id = b.lot_id
 WHERE b.container_id IS NOT NULL AND b.lot_id IS NOT NULL;

-- Estado de calibración de los equipos.
CREATE VIEW equipment_calibration_status AS
SELECT e.id AS equipment_id,
       e.code,
       e.next_calibration_on,
       CASE
           WHEN NOT e.requires_calibration THEN 'NOT_REQUIRED'
           WHEN e.next_calibration_on IS NULL THEN 'UNKNOWN'
           WHEN e.next_calibration_on < current_date THEN 'EXPIRED'
           WHEN e.next_calibration_on <= current_date + coalesce(
                    (SELECT (value #>> '{}')::int FROM system_parameter WHERE key = 'calibration.warning_days'), 30)
                THEN 'DUE_SOON'
           ELSE 'VALID'
       END AS calibration_status
  FROM equipment e;
