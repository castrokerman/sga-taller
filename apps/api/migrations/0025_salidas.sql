-- =============================================================================
-- IDOM ADA · Migración 0025 · Registrar salidas del taller
--
-- Decisiones del 15/11/2026:
--   * Puede salir contenido suelto o un contenedor entero con lo que lleva.
--   * Salida temporal: con destino, fecha de vuelta y aviso. Cuando vence la
--     fecha, el responsable recibe un aviso para indicar si ha regresado a las
--     instalaciones de IDOM. Al volver se elige dónde se guarda.
--   * Salida definitiva: lo que sale queda de baja (el contenedor, retirado;
--     una herramienta o equipo con su propio código, de baja; de un material
--     que se cuenta, se descuenta lo que sale).
--   * Un contenedor puede salir entero o quedarse en el taller para
--     reutilizarlo (22/11/2026): entonces sale solo lo que lleva dentro y el
--     contenedor queda vacío en su sitio (kept_container_id).
--   * Mientras está fuera, un contenedor tiene estado OUT: sin sitio y sin
--     poder meter ni sacar nada.
-- =============================================================================

ALTER TABLE container DROP CONSTRAINT container_status_chk;
ALTER TABLE container ADD CONSTRAINT container_status_chk CHECK (status IN ('ACTIVE', 'RETIRED', 'OUT'));
ALTER TABLE container DROP CONSTRAINT container_place_chk;
ALTER TABLE container ADD CONSTRAINT container_place_chk CHECK (
    (status = 'ACTIVE' AND num_nonnulls(location_id, parent_container_id) = 1)
    OR (status IN ('RETIRED', 'OUT') AND num_nonnulls(location_id, parent_container_id) = 0)
);

ALTER TABLE stock_movement DROP CONSTRAINT stock_movement_type_chk;
ALTER TABLE stock_movement ADD CONSTRAINT stock_movement_type_chk CHECK (movement_type IN (
    'RECEIPT', 'WITHDRAWAL', 'RETURN', 'TRANSFER', 'CONTAINER_MOVE', 'COUNT', 'ADJUSTMENT',
    'LOAN_OUT', 'LOAN_RETURN', 'REVERSAL', 'EXIT', 'EXIT_OUT', 'EXIT_RETURN'));

CREATE TABLE departure (
    id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    number                   integer GENERATED ALWAYS AS IDENTITY UNIQUE,
    kind                     text NOT NULL CHECK (kind IN ('DEFINITIVE', 'TEMPORARY')),
    status                   text NOT NULL CHECK (status IN ('OUT', 'RETURNED', 'DONE')),
    destination              text NOT NULL CHECK (length(destination) BETWEEN 1 AND 200),
    reason                   text CHECK (reason IS NULL OR length(reason) <= 300),
    due_at                   timestamptz,
    container_id             uuid REFERENCES container(id),
    from_location_id         uuid REFERENCES storage_location(id),
    from_parent_container_id uuid REFERENCES container(id),
    responsible_user_id      uuid NOT NULL REFERENCES app_user(id),
    created_by               uuid NOT NULL REFERENCES app_user(id),
    created_at               timestamptz NOT NULL DEFAULT now(),
    out_movement_id          uuid REFERENCES stock_movement(id),
    returned_at              timestamptz,
    returned_by              uuid REFERENCES app_user(id),
    return_movement_id       uuid REFERENCES stock_movement(id),
    due_notified_at          timestamptz,
    kept_container_id        uuid REFERENCES container(id),
    CONSTRAINT departure_due_chk CHECK ((kind = 'TEMPORARY') = (due_at IS NOT NULL)),
    CONSTRAINT departure_status_chk CHECK (
        (kind = 'DEFINITIVE' AND status = 'DONE')
        OR (kind = 'TEMPORARY' AND status IN ('OUT', 'RETURNED'))),
    CONSTRAINT departure_returned_chk CHECK ((status = 'RETURNED') = (returned_at IS NOT NULL))
);
CREATE INDEX departure_open_idx ON departure (due_at) WHERE status = 'OUT';

-- Contenido suelto que sale (para un contenedor, lo que llevaba dentro queda en él).
CREATE TABLE departure_line (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    departure_id      uuid NOT NULL REFERENCES departure(id) ON DELETE CASCADE,
    material_id       uuid NOT NULL REFERENCES material(id),
    lot_id            uuid REFERENCES material_lot(id),
    quantity          numeric(18,4),
    from_container_id uuid REFERENCES container(id),
    from_location_id  uuid REFERENCES storage_location(id)
);
CREATE INDEX departure_line_departure_idx ON departure_line (departure_id);

-- Avisos de salidas temporales vencidas.
ALTER TABLE notification ADD COLUMN departure_id uuid REFERENCES departure(id);
ALTER TABLE notification DROP CONSTRAINT notification_source_chk;
ALTER TABLE notification ADD CONSTRAINT notification_source_chk CHECK (num_nonnulls(note_id, inbound_id, departure_id) = 1);
CREATE INDEX notification_departure_idx ON notification (departure_id) WHERE departure_id IS NOT NULL;
