-- =============================================================================
-- IDOM ADA · Migración 0008 · Fotos, anotaciones y avisos
--
-- Decisiones del 14/11/2026:
--   * Ubicaciones, contenedores y materiales pueden tener varias fotos; la
--     primera es la principal.
--   * En las mismas tres cosas se pueden escribir anotaciones. Llevan fecha,
--     hora y autor, y no se modifican ni se borran.
--   * Una anotación puede notificar a responsables: genera un aviso dentro de
--     la aplicación para cada destinatario. El correo llega en la Fase 5.
--
-- Las fotos se guardan dentro de la base de datos (ya reducidas por la web),
-- así entran en las copias de seguridad y se mudan con ella al servidor.
-- =============================================================================

CREATE TABLE photo (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type text NOT NULL,
    entity_id   uuid NOT NULL,
    position    integer NOT NULL DEFAULT 0,          -- 0 = principal
    mime_type   text NOT NULL,
    width       integer NOT NULL,
    height      integer NOT NULL,
    image       bytea NOT NULL,
    thumbnail   bytea NOT NULL,
    caption     text,
    uploaded_by uuid NOT NULL REFERENCES app_user (id),
    uploaded_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT photo_entity_chk CHECK (entity_type IN ('location', 'container', 'material')),
    CONSTRAINT photo_mime_chk CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp')),
    CONSTRAINT photo_size_chk CHECK (octet_length(image) <= 5 * 1024 * 1024 AND octet_length(thumbnail) <= 512 * 1024)
);
CREATE INDEX photo_entity_idx ON photo (entity_type, entity_id, position);

CREATE TABLE note (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type text NOT NULL,
    entity_id   uuid NOT NULL,
    body        text NOT NULL,
    notify      boolean NOT NULL DEFAULT false,
    created_by  uuid NOT NULL REFERENCES app_user (id),
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT note_entity_chk CHECK (entity_type IN ('location', 'container', 'material')),
    CONSTRAINT note_body_chk CHECK (length(btrim(body)) > 0 AND length(body) <= 4000)
);
CREATE INDEX note_entity_idx ON note (entity_type, entity_id, created_at DESC);

-- Las anotaciones son registro: no se modifican ni se borran.
CREATE TRIGGER note_immutable BEFORE UPDATE OR DELETE ON note
    FOR EACH ROW EXECUTE FUNCTION sga_immutable();
CREATE TRIGGER note_no_truncate BEFORE TRUNCATE ON note
    FOR EACH STATEMENT EXECUTE FUNCTION sga_immutable();

-- Un aviso por destinatario. Solo cambia cuando se marca como leído.
CREATE TABLE notification (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id    uuid NOT NULL REFERENCES app_user (id),
    note_id    uuid NOT NULL REFERENCES note (id),
    created_at timestamptz NOT NULL DEFAULT now(),
    read_at    timestamptz,
    UNIQUE (user_id, note_id)
);
CREATE INDEX notification_unread_idx ON notification (user_id, created_at DESC) WHERE read_at IS NULL;

-- Permisos nuevos: todos menos el usuario de consulta pueden añadir fotos y
-- anotaciones; quitar fotos de otros, solo responsables de almacén y administradores.
INSERT INTO permission (code, description) VALUES
    ('photo.add',    'Añadir fotos a ubicaciones, contenedores y materiales'),
    ('photo.manage', 'Quitar y ordenar las fotos de cualquiera'),
    ('note.add',     'Escribir anotaciones y notificar a responsables');

INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id
  FROM (VALUES
    ('USUARIO', 'photo.add'), ('USUARIO', 'note.add'),
    ('RESP_PROYECTO', 'photo.add'), ('RESP_PROYECTO', 'note.add'),
    ('RESP_ALMACEN', 'photo.add'), ('RESP_ALMACEN', 'note.add'), ('RESP_ALMACEN', 'photo.manage'),
    ('ADMIN_TECNICO', 'photo.add'), ('ADMIN_TECNICO', 'note.add'), ('ADMIN_TECNICO', 'photo.manage')
  ) AS x (role_code, permission_code)
  JOIN role r ON r.code = x.role_code
  JOIN permission p ON p.code = x.permission_code;
