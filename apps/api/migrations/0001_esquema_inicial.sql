-- =============================================================================
-- SGA Taller · Migración 0001 · Esquema inicial completo
-- PostgreSQL 16
--
-- Convenciones:
--   * Claves primarias uuid generadas en base de datos.
--   * Fechas en timestamptz (UTC).
--   * Enumerados como text + CHECK (más fáciles de ampliar que los tipos ENUM).
--   * Cantidades en numeric(18,4).
--   * El stock físico (stock_balance) y el reparto lógico (stock_allocation)
--     son tablas distintas. Solo los movimientos modifican el físico.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. USUARIOS, ROLES, PERMISOS Y SESIONES
-- -----------------------------------------------------------------------------

CREATE TABLE app_user (
    id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    username             text NOT NULL,
    full_name            text NOT NULL,
    email                text,
    password_hash        text NOT NULL,
    active               boolean NOT NULL DEFAULT true,
    must_change_password boolean NOT NULL DEFAULT false,
    failed_login_count   integer NOT NULL DEFAULT 0,
    locked_until         timestamptz,
    last_login_at        timestamptz,
    created_at           timestamptz NOT NULL DEFAULT now(),
    updated_at           timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT app_user_username_format CHECK (username = lower(username) AND length(username) >= 3)
);
CREATE UNIQUE INDEX app_user_username_uq ON app_user (username);

CREATE TABLE role (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code        text NOT NULL UNIQUE,
    name        text NOT NULL,
    description text,
    is_system   boolean NOT NULL DEFAULT false
);

CREATE TABLE permission (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code        text NOT NULL UNIQUE,
    description text NOT NULL
);

CREATE TABLE role_permission (
    role_id       uuid NOT NULL REFERENCES role (id) ON DELETE CASCADE,
    permission_id uuid NOT NULL REFERENCES permission (id) ON DELETE CASCADE,
    PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE user_role (
    user_id uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
    role_id uuid NOT NULL REFERENCES role (id) ON DELETE RESTRICT,
    PRIMARY KEY (user_id, role_id)
);
CREATE INDEX user_role_role_idx ON user_role (role_id);

CREATE TABLE user_session (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
    token_hash   text NOT NULL UNIQUE,          -- nunca se guarda el token en claro
    created_at   timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    expires_at   timestamptz NOT NULL,
    revoked_at   timestamptz,
    ip           inet,
    user_agent   text
);
CREATE INDEX user_session_user_idx ON user_session (user_id);
CREATE INDEX user_session_expires_idx ON user_session (expires_at);

CREATE TABLE system_parameter (
    key         text PRIMARY KEY,
    value       jsonb NOT NULL,
    description text NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now(),
    updated_by  uuid REFERENCES app_user (id)
);

-- -----------------------------------------------------------------------------
-- 2. CLIENTES, LÍNEAS DE NEGOCIO Y PROYECTOS
-- -----------------------------------------------------------------------------

CREATE TABLE customer (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code       text NOT NULL UNIQUE,
    name       text NOT NULL,
    active     boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE business_line (
    id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code   text NOT NULL UNIQUE,
    name   text NOT NULL,
    active boolean NOT NULL DEFAULT true
);

CREATE TABLE project (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code                text NOT NULL UNIQUE,
    name                text NOT NULL,
    customer_id         uuid REFERENCES customer (id),
    business_line_id    uuid REFERENCES business_line (id),
    responsible_user_id uuid NOT NULL REFERENCES app_user (id),
    status              text NOT NULL DEFAULT 'ACTIVE',
    allow_self_approval boolean NOT NULL DEFAULT false,   -- política explícita por proyecto
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT project_status_chk CHECK (status IN ('ACTIVE', 'ON_HOLD', 'CLOSED'))
);
CREATE INDEX project_customer_idx ON project (customer_id);
CREATE INDEX project_responsible_idx ON project (responsible_user_id);

-- Quién puede aprobar retiradas restringidas de cada proyecto.
-- Es independiente del rol técnico: ser administrador no da esta capacidad.
CREATE TABLE project_authorizer (
    project_id uuid NOT NULL REFERENCES project (id) ON DELETE CASCADE,
    user_id    uuid NOT NULL REFERENCES app_user (id),
    kind       text NOT NULL DEFAULT 'PRIMARY',
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, user_id),
    CONSTRAINT project_authorizer_kind_chk CHECK (kind IN ('PRIMARY', 'DEPUTY'))
);
CREATE INDEX project_authorizer_user_idx ON project_authorizer (user_id);

-- -----------------------------------------------------------------------------
-- 3. UBICACIONES (lo fijo)
-- -----------------------------------------------------------------------------

CREATE TABLE location_type (
    id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code   text NOT NULL UNIQUE,
    name   text NOT NULL,
    active boolean NOT NULL DEFAULT true
);

CREATE TABLE storage_location (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    qr_token               text NOT NULL UNIQUE,        -- token aleatorio e inmutable
    code                   text NOT NULL UNIQUE,        -- código legible, puede cambiar
    name                   text NOT NULL,
    description            text,
    parent_id              uuid REFERENCES storage_location (id) ON DELETE RESTRICT,
    location_type_id       uuid NOT NULL REFERENCES location_type (id),
    max_capacity           numeric(18,4),
    capacity_unit          text,
    allowed_hazard_classes text[] NOT NULL DEFAULT '{}', -- p. ej. {LIQUIDO,QUIMICO}
    restrictions_note      text,
    active                 boolean NOT NULL DEFAULT true,
    created_at             timestamptz NOT NULL DEFAULT now(),
    updated_at             timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT storage_location_not_own_parent CHECK (parent_id IS NULL OR parent_id <> id),
    CONSTRAINT storage_location_capacity_chk CHECK (max_capacity IS NULL OR max_capacity > 0)
);
CREATE INDEX storage_location_parent_idx ON storage_location (parent_id);

-- -----------------------------------------------------------------------------
-- 4. CONTENEDORES (lo que se mueve)
-- -----------------------------------------------------------------------------

CREATE TABLE container_type (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code        text NOT NULL UNIQUE,
    name        text NOT NULL,
    code_prefix text NOT NULL UNIQUE,                    -- PAL, CAJ, BAN...
    next_number integer NOT NULL DEFAULT 1,              -- contador de códigos legibles
    default_reuse_policy text NOT NULL DEFAULT 'REUSABLE',
    active      boolean NOT NULL DEFAULT true,
    CONSTRAINT container_type_policy_chk CHECK (default_reuse_policy IN ('REUSABLE', 'DISPOSABLE'))
);

CREATE TABLE container (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    qr_token            text NOT NULL UNIQUE,
    code                text NOT NULL UNIQUE,            -- p. ej. PAL-000125
    container_type_id   uuid NOT NULL REFERENCES container_type (id),
    location_id         uuid REFERENCES storage_location (id) ON DELETE RESTRICT,
    parent_container_id uuid REFERENCES container (id) ON DELETE RESTRICT,
    status              text NOT NULL DEFAULT 'ACTIVE',
    reuse_policy        text NOT NULL DEFAULT 'REUSABLE',
    responsible_user_id uuid REFERENCES app_user (id),
    description         text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    retired_at          timestamptz,
    CONSTRAINT container_status_chk CHECK (status IN ('ACTIVE', 'RETIRED')),
    CONSTRAINT container_policy_chk CHECK (reuse_policy IN ('REUSABLE', 'DISPOSABLE')),
    CONSTRAINT container_not_own_parent CHECK (parent_container_id IS NULL OR parent_container_id <> id),
    -- Un contenedor activo está en una ubicación O dentro de otro contenedor, nunca ambas.
    -- Solo el contenedor raíz guarda ubicación; los descendientes la heredan.
    CONSTRAINT container_place_chk CHECK (
        (status = 'ACTIVE'  AND num_nonnulls(location_id, parent_container_id) = 1)
     OR (status = 'RETIRED' AND num_nonnulls(location_id, parent_container_id) = 0)
    ),
    CONSTRAINT container_retired_chk CHECK ((status = 'RETIRED') = (retired_at IS NOT NULL))
);
CREATE INDEX container_location_idx ON container (location_id);
CREATE INDEX container_parent_idx ON container (parent_container_id);
CREATE INDEX container_type_idx ON container (container_type_id);

-- -----------------------------------------------------------------------------
-- 5. MATERIALES Y LOTES
-- -----------------------------------------------------------------------------

CREATE TABLE unit_of_measure (
    code     text PRIMARY KEY,                           -- ud, m, kg, l...
    name     text NOT NULL,
    decimals smallint NOT NULL DEFAULT 0,
    CONSTRAINT unit_decimals_chk CHECK (decimals BETWEEN 0 AND 4)
);

CREATE TABLE material_family (
    id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code   text NOT NULL UNIQUE,
    name   text NOT NULL,
    active boolean NOT NULL DEFAULT true
);

CREATE TABLE material (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    internal_ref      text NOT NULL UNIQUE,
    manufacturer_ref  text,
    manufacturer      text,
    description       text NOT NULL,
    family_id         uuid NOT NULL REFERENCES material_family (id),
    material_spec     text,                              -- material: acero, aluminio...
    quality_grade     text,                              -- calidad: S355, 6082-T6...
    dimensions        text,
    unit_code         text NOT NULL REFERENCES unit_of_measure (code),
    quantity_tracking text NOT NULL DEFAULT 'EXACT',
    lot_tracked       boolean NOT NULL DEFAULT false,
    is_loanable       boolean NOT NULL DEFAULT false,    -- herramientas y equipos: se prestan
    hazard_class      text,                              -- LIQUIDO, QUIMICO... o NULL
    status            text NOT NULL DEFAULT 'ACTIVE',
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT material_tracking_chk CHECK (quantity_tracking IN ('EXACT', 'ESTIMATED', 'NOT_TRACKED')),
    CONSTRAINT material_status_chk CHECK (status IN ('ACTIVE', 'OBSOLETE'))
);
CREATE INDEX material_family_idx ON material (family_id);
CREATE INDEX material_manufacturer_ref_idx ON material (manufacturer_ref);
CREATE INDEX material_search_idx ON material
    USING gin (to_tsvector('spanish',
        coalesce(internal_ref, '') || ' ' || coalesce(manufacturer_ref, '') || ' ' ||
        coalesce(manufacturer, '') || ' ' || coalesce(description, '') || ' ' ||
        coalesce(material_spec, '') || ' ' || coalesce(quality_grade, '') || ' ' ||
        coalesce(dimensions, '')));

CREATE TABLE material_lot (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    material_id uuid NOT NULL REFERENCES material (id) ON DELETE RESTRICT,
    lot_code    text NOT NULL,
    heat_number text,                                    -- colada
    supplier    text,
    received_on date,
    expires_on  date,
    notes       text,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (material_id, lot_code),
    UNIQUE (id, material_id)                             -- permite la FK compuesta de stock_balance
);
CREATE INDEX material_lot_code_idx ON material_lot (lot_code);

-- -----------------------------------------------------------------------------
-- 6. STOCK FÍSICO
-- -----------------------------------------------------------------------------

-- Una fila = cuánto hay de un material (y lote) en un lugar concreto.
-- El lugar es un contenedor O una ubicación, nunca ambos.
-- quantity es NULL solo en materiales NOT_TRACKED (la fila indica presencia).
CREATE TABLE stock_balance (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    material_id     uuid NOT NULL REFERENCES material (id) ON DELETE RESTRICT,
    lot_id          uuid,
    container_id    uuid REFERENCES container (id) ON DELETE RESTRICT,
    location_id     uuid REFERENCES storage_location (id) ON DELETE RESTRICT,
    quantity        numeric(18,4),
    needs_recount   boolean NOT NULL DEFAULT false,
    last_counted_at timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT stock_balance_lot_fk FOREIGN KEY (lot_id, material_id)
        REFERENCES material_lot (id, material_id) ON DELETE RESTRICT,
    CONSTRAINT stock_balance_place_chk CHECK (num_nonnulls(container_id, location_id) = 1),
    CONSTRAINT stock_balance_non_negative CHECK (quantity IS NULL OR quantity >= 0),
    CONSTRAINT stock_balance_uq UNIQUE NULLS NOT DISTINCT (material_id, lot_id, container_id, location_id)
);
CREATE INDEX stock_balance_material_idx ON stock_balance (material_id);
CREATE INDEX stock_balance_lot_idx ON stock_balance (lot_id);
CREATE INDEX stock_balance_container_idx ON stock_balance (container_id);
CREATE INDEX stock_balance_location_idx ON stock_balance (location_id);

-- -----------------------------------------------------------------------------
-- 7. ASIGNACIONES LÓGICAS
-- -----------------------------------------------------------------------------

-- Reparto de un saldo físico entre proyectos. Lo que no está asignado es
-- de libre disposición. La suma de asignaciones nunca supera el físico.
CREATE TABLE stock_allocation (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    stock_balance_id    uuid NOT NULL REFERENCES stock_balance (id) ON DELETE RESTRICT,
    project_id          uuid NOT NULL REFERENCES project (id) ON DELETE RESTRICT,
    availability        text NOT NULL DEFAULT 'RESTRICTED',
    quantity            numeric(18,4) NOT NULL,
    responsible_user_id uuid REFERENCES app_user (id),
    note                text,
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT stock_allocation_availability_chk CHECK (availability IN ('FREE', 'RESTRICTED')),
    CONSTRAINT stock_allocation_non_negative CHECK (quantity >= 0),
    UNIQUE (stock_balance_id, project_id, availability)
);
CREATE INDEX stock_allocation_project_idx ON stock_allocation (project_id);

-- -----------------------------------------------------------------------------
-- 8. SOLICITUDES, AUTORIZACIONES Y RESERVAS
-- -----------------------------------------------------------------------------

CREATE TABLE withdrawal_request (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    request_number      bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    requester_id        uuid NOT NULL REFERENCES app_user (id),
    stock_allocation_id uuid NOT NULL REFERENCES stock_allocation (id) ON DELETE RESTRICT,
    -- Copia de los datos a los que queda ligada la aprobación.
    -- Si cambia alguno, hace falta una solicitud nueva.
    material_id         uuid NOT NULL REFERENCES material (id),
    lot_id              uuid REFERENCES material_lot (id),
    container_id        uuid REFERENCES container (id),
    location_id         uuid REFERENCES storage_location (id),
    project_id          uuid NOT NULL REFERENCES project (id),
    quantity_requested  numeric(18,4) NOT NULL,
    reason              text NOT NULL,
    status              text NOT NULL DEFAULT 'PENDING',
    created_at          timestamptz NOT NULL DEFAULT now(),
    decided_at          timestamptz,
    closed_at           timestamptz,
    CONSTRAINT withdrawal_request_qty_chk CHECK (quantity_requested > 0),
    CONSTRAINT withdrawal_request_reason_chk CHECK (length(btrim(reason)) > 0),
    CONSTRAINT withdrawal_request_place_chk CHECK (num_nonnulls(container_id, location_id) = 1),
    CONSTRAINT withdrawal_request_status_chk CHECK (status IN
        ('PENDING', 'APPROVED', 'PARTIALLY_APPROVED', 'REJECTED', 'FULFILLED', 'CANCELLED', 'EXPIRED'))
);
CREATE INDEX withdrawal_request_status_idx ON withdrawal_request (status);
CREATE INDEX withdrawal_request_requester_idx ON withdrawal_request (requester_id);
CREATE INDEX withdrawal_request_project_idx ON withdrawal_request (project_id);
CREATE INDEX withdrawal_request_allocation_idx ON withdrawal_request (stock_allocation_id);

-- Una única decisión por solicitud.
CREATE TABLE withdrawal_authorization (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id          uuid NOT NULL UNIQUE REFERENCES withdrawal_request (id) ON DELETE RESTRICT,
    authorizer_id       uuid NOT NULL REFERENCES app_user (id),
    decision            text NOT NULL,
    quantity_authorized numeric(18,4),
    comment             text,
    decided_at          timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT withdrawal_authorization_decision_chk CHECK (decision IN ('APPROVED', 'PARTIALLY_APPROVED', 'REJECTED')),
    CONSTRAINT withdrawal_authorization_qty_chk CHECK (
        (decision = 'REJECTED' AND quantity_authorized IS NULL)
     OR (decision <> 'REJECTED' AND quantity_authorized > 0)
    )
);
CREATE INDEX withdrawal_authorization_authorizer_idx ON withdrawal_authorization (authorizer_id);

-- Reserva temporal creada al aprobar. No descuenta stock: solo bloquea
-- cantidad de la asignación hasta que se retira, caduca o se cancela.
CREATE TABLE stock_reservation (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id          uuid NOT NULL UNIQUE REFERENCES withdrawal_request (id) ON DELETE RESTRICT,
    authorization_id    uuid NOT NULL UNIQUE REFERENCES withdrawal_authorization (id) ON DELETE RESTRICT,
    stock_allocation_id uuid NOT NULL REFERENCES stock_allocation (id) ON DELETE RESTRICT,
    quantity            numeric(18,4) NOT NULL,
    quantity_consumed   numeric(18,4) NOT NULL DEFAULT 0,
    status              text NOT NULL DEFAULT 'ACTIVE',
    expires_at          timestamptz NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    closed_at           timestamptz,
    CONSTRAINT stock_reservation_qty_chk CHECK (quantity > 0),
    CONSTRAINT stock_reservation_consumed_chk CHECK (quantity_consumed >= 0 AND quantity_consumed <= quantity),
    CONSTRAINT stock_reservation_status_chk CHECK (status IN ('ACTIVE', 'CONSUMED', 'EXPIRED', 'CANCELLED'))
);
CREATE INDEX stock_reservation_allocation_idx ON stock_reservation (stock_allocation_id);
CREATE INDEX stock_reservation_active_expiry_idx ON stock_reservation (expires_at) WHERE status = 'ACTIVE';

-- -----------------------------------------------------------------------------
-- 9. MOVIMIENTOS (historial inmutable)
-- -----------------------------------------------------------------------------

CREATE TABLE stock_movement (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    movement_number       bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    movement_type         text NOT NULL,
    performed_by          uuid NOT NULL REFERENCES app_user (id),
    performed_at          timestamptz NOT NULL DEFAULT now(),
    reason                text,
    external_reference    text,                          -- albarán, pedido...
    withdrawal_request_id uuid REFERENCES withdrawal_request (id),
    reverses_movement_id  uuid UNIQUE REFERENCES stock_movement (id), -- un movimiento se revierte una sola vez
    idempotency_key       text UNIQUE,
    CONSTRAINT stock_movement_type_chk CHECK (movement_type IN (
        'RECEIPT',         -- entrada
        'WITHDRAWAL',      -- retirada
        'RETURN',          -- devolución
        'TRANSFER',        -- traslado de material entre lugares
        'CONTAINER_MOVE',  -- movimiento de un contenedor completo
        'COUNT',           -- recuento
        'ADJUSTMENT',      -- ajuste de inventario
        'LOAN_OUT',        -- préstamo de herramienta o equipo
        'LOAN_RETURN',     -- devolución de préstamo
        'REVERSAL'         -- reverso de otro movimiento
    )),
    CONSTRAINT stock_movement_reversal_chk CHECK ((movement_type = 'REVERSAL') = (reverses_movement_id IS NOT NULL))
);
CREATE INDEX stock_movement_performed_at_idx ON stock_movement (performed_at DESC);
CREATE INDEX stock_movement_user_idx ON stock_movement (performed_by);
CREATE INDEX stock_movement_request_idx ON stock_movement (withdrawal_request_id);

-- Dos clases de línea:
--   * de stock: material (+ lote) en un lugar, con su variación de cantidad;
--   * de contenedor: un contenedor que cambia de ubicación o de padre.
CREATE TABLE stock_movement_line (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    movement_id              uuid NOT NULL REFERENCES stock_movement (id) ON DELETE RESTRICT,
    line_no                  integer NOT NULL,
    -- línea de stock
    material_id              uuid REFERENCES material (id),
    lot_id                   uuid REFERENCES material_lot (id),
    container_id             uuid REFERENCES container (id),
    location_id              uuid REFERENCES storage_location (id),
    quantity_delta           numeric(18,4),              -- con signo; NULL en NOT_TRACKED
    quantity_after           numeric(18,4),
    quantity_tracking        text,                       -- copia del modo en el momento del movimiento
    project_id               uuid REFERENCES project (id),
    -- línea de contenedor
    moved_container_id       uuid REFERENCES container (id),
    from_location_id         uuid REFERENCES storage_location (id),
    from_parent_container_id uuid REFERENCES container (id),
    to_location_id           uuid REFERENCES storage_location (id),
    to_parent_container_id   uuid REFERENCES container (id),
    UNIQUE (movement_id, line_no),
    CONSTRAINT movement_line_kind_chk CHECK (num_nonnulls(material_id, moved_container_id) = 1),
    CONSTRAINT movement_line_stock_place_chk CHECK (
        material_id IS NULL OR num_nonnulls(container_id, location_id) = 1),
    CONSTRAINT movement_line_container_dest_chk CHECK (
        moved_container_id IS NULL OR num_nonnulls(to_location_id, to_parent_container_id) <= 1),
    CONSTRAINT movement_line_tracking_chk CHECK (
        quantity_tracking IS NULL OR quantity_tracking IN ('EXACT', 'ESTIMATED', 'NOT_TRACKED'))
);
CREATE INDEX movement_line_material_idx ON stock_movement_line (material_id);
CREATE INDEX movement_line_lot_idx ON stock_movement_line (lot_id);
CREATE INDEX movement_line_container_idx ON stock_movement_line (container_id);
CREATE INDEX movement_line_location_idx ON stock_movement_line (location_id);
CREATE INDEX movement_line_moved_container_idx ON stock_movement_line (moved_container_id);
CREATE INDEX movement_line_project_idx ON stock_movement_line (project_id);

-- Claves de idempotencia de la API: repetir una operación devuelve la respuesta original.
CREATE TABLE idempotency_key (
    key           text PRIMARY KEY,
    user_id       uuid NOT NULL REFERENCES app_user (id),
    endpoint      text NOT NULL,
    request_hash  text NOT NULL,
    response_code integer,
    response_body jsonb,
    created_at    timestamptz NOT NULL DEFAULT now(),
    completed_at  timestamptz
);
CREATE INDEX idempotency_key_created_idx ON idempotency_key (created_at);

-- -----------------------------------------------------------------------------
-- 10. DOCUMENTOS, EQUIPOS, CALIBRACIONES Y PRÉSTAMOS
-- -----------------------------------------------------------------------------

CREATE TABLE document_type (
    id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code   text NOT NULL UNIQUE,
    name   text NOT NULL,
    active boolean NOT NULL DEFAULT true
);

CREATE TABLE document (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    document_type_id   uuid NOT NULL REFERENCES document_type (id),
    title              text NOT NULL,
    certificate_number text,
    issuer             text,
    issued_on          date,
    expires_on         date,
    validation_status  text NOT NULL DEFAULT 'PENDING',
    validated_by       uuid REFERENCES app_user (id),
    validated_at       timestamptz,
    active             boolean NOT NULL DEFAULT true,
    created_by         uuid NOT NULL REFERENCES app_user (id),
    created_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT document_validation_chk CHECK (validation_status IN ('PENDING', 'VALIDATED', 'REJECTED')),
    CONSTRAINT document_dates_chk CHECK (expires_on IS NULL OR issued_on IS NULL OR expires_on >= issued_on)
);
CREATE INDEX document_type_idx ON document (document_type_id);
CREATE INDEX document_certificate_idx ON document (certificate_number);
CREATE INDEX document_expires_idx ON document (expires_on) WHERE expires_on IS NOT NULL;

CREATE TABLE document_version (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id       uuid NOT NULL REFERENCES document (id) ON DELETE RESTRICT,
    version_no        integer NOT NULL,
    storage_key       text NOT NULL UNIQUE,              -- ruta dentro del almacén de ficheros
    original_filename text NOT NULL,
    mime_type         text NOT NULL,
    size_bytes        bigint NOT NULL,
    sha256            text NOT NULL,
    uploaded_by       uuid NOT NULL REFERENCES app_user (id),
    uploaded_at       timestamptz NOT NULL DEFAULT now(),
    notes             text,
    UNIQUE (document_id, version_no),
    CONSTRAINT document_version_no_chk CHECK (version_no >= 1),
    CONSTRAINT document_version_size_chk CHECK (size_bytes >= 0)
);

CREATE TABLE equipment (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    qr_token                  text NOT NULL UNIQUE,
    code                      text NOT NULL UNIQUE,
    description               text NOT NULL,
    serial_number             text,
    manufacturer              text,
    model                     text,
    location_id               uuid REFERENCES storage_location (id),
    container_id              uuid REFERENCES container (id),
    responsible_user_id       uuid REFERENCES app_user (id),
    requires_calibration      boolean NOT NULL DEFAULT true,
    calibration_interval_days integer,
    last_calibrated_on        date,
    next_calibration_on       date,
    status                    text NOT NULL DEFAULT 'ACTIVE',
    created_at                timestamptz NOT NULL DEFAULT now(),
    updated_at                timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT equipment_status_chk CHECK (status IN ('ACTIVE', 'OUT_OF_SERVICE', 'RETIRED')),
    CONSTRAINT equipment_place_chk CHECK (num_nonnulls(location_id, container_id) <= 1),
    CONSTRAINT equipment_interval_chk CHECK (calibration_interval_days IS NULL OR calibration_interval_days > 0)
);
CREATE INDEX equipment_next_calibration_idx ON equipment (next_calibration_on) WHERE requires_calibration;

CREATE TABLE calibration_record (
    id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    equipment_id            uuid NOT NULL REFERENCES equipment (id) ON DELETE RESTRICT,
    calibrated_on           date NOT NULL,
    next_due_on             date NOT NULL,
    performed_by_org        text,                        -- laboratorio
    result                  text NOT NULL DEFAULT 'PASS',
    certificate_document_id uuid REFERENCES document (id),
    recorded_by             uuid NOT NULL REFERENCES app_user (id),
    recorded_at             timestamptz NOT NULL DEFAULT now(),
    notes                   text,
    CONSTRAINT calibration_result_chk CHECK (result IN ('PASS', 'ADJUSTED', 'FAIL')),
    CONSTRAINT calibration_dates_chk CHECK (next_due_on > calibrated_on)
);
CREATE INDEX calibration_record_equipment_idx ON calibration_record (equipment_id, calibrated_on DESC);

-- Relación de un documento con aquello que documenta (exactamente una cosa por fila).
-- Los certificados de material se ligan al LOTE, no al contenedor: así siguen
-- visibles desde cualquier caja que contenga material de ese lote.
CREATE TABLE document_relation (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id  uuid NOT NULL REFERENCES document (id) ON DELETE RESTRICT,
    material_id  uuid REFERENCES material (id),
    lot_id       uuid REFERENCES material_lot (id),
    container_id uuid REFERENCES container (id),
    equipment_id uuid REFERENCES equipment (id),
    project_id   uuid REFERENCES project (id),
    created_by   uuid NOT NULL REFERENCES app_user (id),
    created_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT document_relation_one_target_chk CHECK (
        num_nonnulls(material_id, lot_id, container_id, equipment_id, project_id) = 1),
    CONSTRAINT document_relation_uq UNIQUE NULLS NOT DISTINCT
        (document_id, material_id, lot_id, container_id, equipment_id, project_id)
);
CREATE INDEX document_relation_material_idx ON document_relation (material_id);
CREATE INDEX document_relation_lot_idx ON document_relation (lot_id);
CREATE INDEX document_relation_container_idx ON document_relation (container_id);
CREATE INDEX document_relation_equipment_idx ON document_relation (equipment_id);
CREATE INDEX document_relation_project_idx ON document_relation (project_id);

-- Préstamo de herramientas (material prestable) o de equipos.
CREATE TABLE tool_loan (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    material_id        uuid REFERENCES material (id),
    lot_id             uuid REFERENCES material_lot (id),
    equipment_id       uuid REFERENCES equipment (id),
    quantity           numeric(18,4) NOT NULL DEFAULT 1,
    borrower_id        uuid NOT NULL REFERENCES app_user (id),
    loaned_at          timestamptz NOT NULL DEFAULT now(),
    due_at             timestamptz NOT NULL,             -- si no se indica: hoy + parámetro (14 días)
    returned_at        timestamptz,
    status             text NOT NULL DEFAULT 'OPEN',
    out_movement_id    uuid REFERENCES stock_movement (id),
    return_movement_id uuid REFERENCES stock_movement (id),
    notes              text,
    CONSTRAINT tool_loan_target_chk CHECK (num_nonnulls(material_id, equipment_id) = 1),
    CONSTRAINT tool_loan_qty_chk CHECK (quantity > 0),
    CONSTRAINT tool_loan_due_chk CHECK (due_at > loaned_at),
    CONSTRAINT tool_loan_status_chk CHECK (status IN ('OPEN', 'RETURNED', 'LOST')),
    CONSTRAINT tool_loan_returned_chk CHECK ((status = 'RETURNED') = (returned_at IS NOT NULL))
);
CREATE INDEX tool_loan_borrower_idx ON tool_loan (borrower_id);
CREATE INDEX tool_loan_open_due_idx ON tool_loan (due_at) WHERE status = 'OPEN';
-- Un equipo solo puede tener un préstamo abierto a la vez.
CREATE UNIQUE INDEX tool_loan_equipment_open_uq ON tool_loan (equipment_id) WHERE status = 'OPEN' AND equipment_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 11. AUDITORÍA
-- -----------------------------------------------------------------------------

CREATE TABLE audit_log (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    user_id     uuid REFERENCES app_user (id),
    action      text NOT NULL,                           -- p. ej. user.login, material.update
    entity_type text,
    entity_id   text,
    before_data jsonb,
    after_data  jsonb,
    ip          inet,
    request_id  text
);
CREATE INDEX audit_log_occurred_idx ON audit_log (occurred_at DESC);
CREATE INDEX audit_log_user_idx ON audit_log (user_id);
CREATE INDEX audit_log_entity_idx ON audit_log (entity_type, entity_id);
