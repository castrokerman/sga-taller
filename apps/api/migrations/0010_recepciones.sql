-- =============================================================================
-- IDOM ADA · Migración 0010 · Recepciones pendientes de identificar
--
-- Decisiones del 15/11/2026:
--   * Mucho de lo que llega al taller no lo sabe identificar quien lo recibe:
--     lo pidió otra persona. Quien lo recibe hace una foto, indica quién es el
--     responsable y en qué sitio provisional lo deja.
--   * El responsable recibe un aviso y completa el registro: qué es (un
--     material del catálogo o uno nuevo), cuánto, proyecto, dónde se va a
--     usar y si se guarda en el almacén o se despliega directamente.
--   * Al completarlo se hacen los movimientos de stock de siempre, así queda
--     la huella: entrada en el sitio donde se guarda o, si se despliega,
--     entrada y salida en el sitio provisional.
--   * El proyecto es, por ahora, texto libre. Se enlazará con los proyectos
--     de la Fase 4.
-- =============================================================================

CREATE TABLE inbound_item (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    number                 integer GENERATED ALWAYS AS IDENTITY UNIQUE,
    status                 text NOT NULL DEFAULT 'PENDING',
    -- Lo que anota quien lo recibe.
    description            text,                     -- lo que se ve: «caja de cartón con 3 piezas»
    packages               integer,                  -- bultos
    external_reference     text,                     -- albarán, pedido
    received_by            uuid NOT NULL REFERENCES app_user (id),
    received_at            timestamptz NOT NULL DEFAULT now(),
    responsible_user_id    uuid NOT NULL REFERENCES app_user (id),
    container_id           uuid REFERENCES container (id),          -- sitio provisional
    location_id            uuid REFERENCES storage_location (id),
    -- Lo que completa el responsable.
    material_id            uuid REFERENCES material (id),
    quantity               numeric(18, 6),
    lot_code               text,
    project_ref            text,
    usage_place            text,
    disposition            text,
    final_container_id     uuid REFERENCES container (id),
    final_location_id      uuid REFERENCES storage_location (id),
    completion_note        text,
    completed_by           uuid REFERENCES app_user (id),
    completed_at           timestamptz,
    receipt_movement_id    uuid REFERENCES stock_movement (id),
    withdrawal_movement_id uuid REFERENCES stock_movement (id),
    -- Si se anula (registrada por error, duplicada...).
    cancel_reason          text,
    cancelled_by           uuid REFERENCES app_user (id),
    cancelled_at           timestamptz,
    CONSTRAINT inbound_status_chk CHECK (status IN ('PENDING', 'DONE', 'CANCELLED')),
    CONSTRAINT inbound_place_chk CHECK ((container_id IS NULL) <> (location_id IS NULL)),
    CONSTRAINT inbound_packages_chk CHECK (packages IS NULL OR packages BETWEEN 1 AND 9999),
    CONSTRAINT inbound_disposition_chk CHECK (disposition IS NULL OR disposition IN ('STORE', 'DEPLOY')),
    CONSTRAINT inbound_done_chk CHECK (
        status <> 'DONE' OR (material_id IS NOT NULL AND disposition IS NOT NULL AND completed_at IS NOT NULL AND completed_by IS NOT NULL)),
    CONSTRAINT inbound_cancel_chk CHECK (status <> 'CANCELLED' OR (cancelled_at IS NOT NULL AND cancelled_by IS NOT NULL))
);
CREATE INDEX inbound_pending_idx ON inbound_item (responsible_user_id, received_at DESC) WHERE status = 'PENDING';
CREATE INDEX inbound_received_idx ON inbound_item (received_at DESC);

-- Las fotos de lo recibido van con las demás fotos.
ALTER TABLE photo DROP CONSTRAINT photo_entity_chk;
ALTER TABLE photo ADD CONSTRAINT photo_entity_chk CHECK (entity_type IN ('location', 'container', 'material', 'inbound'));

-- Los avisos pueden venir de una anotación o de una recepción.
ALTER TABLE notification ALTER COLUMN note_id DROP NOT NULL;
ALTER TABLE notification
    ADD COLUMN inbound_id uuid REFERENCES inbound_item (id),
    ADD COLUMN message    text,
    ADD COLUMN created_by uuid REFERENCES app_user (id),
    ADD CONSTRAINT notification_source_chk CHECK ((note_id IS NULL) <> (inbound_id IS NULL));
CREATE INDEX notification_inbound_idx ON notification (inbound_id) WHERE inbound_id IS NOT NULL;

-- Quién gestiona todas las recepciones (ver, completar, reasignar y anular
-- cualquiera). Registrar una recepción necesita el permiso de entrada de
-- material; completar la suya la puede hacer cualquier responsable asignado.
INSERT INTO permission (code, description) VALUES
    ('inbound.manage', 'Ver, completar, reasignar y anular todas las recepciones pendientes');

INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id FROM role r, permission p
 WHERE r.code IN ('RESP_ALMACEN', 'ADMIN_TECNICO') AND p.code = 'inbound.manage';
