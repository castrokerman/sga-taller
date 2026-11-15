-- =============================================================================
-- IDOM ADA · Migración 0018 · Pre-recepciones
--
-- Decisión del 15/11/2026: quien espera un paquete (por ejemplo, un pedido a
-- un proveedor) lo anuncia con una pre-recepción. Cuando el almacén registra
-- una recepción, se le proponen las pre-recepciones abiertas que encajan; si
-- elige una, la recepción queda enlazada, va a quien la anunció (o a los
-- responsables de su proyecto) y se le avisa de que ha llegado.
-- =============================================================================

CREATE TABLE pre_receipt (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    number        integer GENERATED ALWAYS AS IDENTITY UNIQUE,
    status        text NOT NULL DEFAULT 'OPEN',
    description   text NOT NULL,
    supplier      text,
    order_ref     text,
    project_id    uuid REFERENCES project (id),
    expected_date date,
    note          text,
    created_by    uuid NOT NULL REFERENCES app_user (id),
    created_at    timestamptz NOT NULL DEFAULT now(),
    inbound_id    uuid REFERENCES inbound_item (id),
    received_at   timestamptz,
    cancelled_at  timestamptz,
    cancelled_by  uuid REFERENCES app_user (id),
    CONSTRAINT pre_receipt_status_chk CHECK (status IN ('OPEN', 'RECEIVED', 'CANCELLED')),
    CONSTRAINT pre_receipt_description_chk CHECK (length(btrim(description)) > 0),
    CONSTRAINT pre_receipt_received_chk CHECK (status <> 'RECEIVED' OR inbound_id IS NOT NULL)
);
CREATE INDEX pre_receipt_open_idx ON pre_receipt (expected_date) WHERE status = 'OPEN';
CREATE INDEX pre_receipt_user_idx ON pre_receipt (created_by, created_at DESC);

ALTER TABLE inbound_item ADD COLUMN pre_receipt_id uuid REFERENCES pre_receipt (id);
