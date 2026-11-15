-- =============================================================================
-- IDOM ADA · Migración 0009 · Prefijo de código por tipo de ubicación
--
-- Decisiones del 15/11/2026:
--   * Cada tipo de ubicación tiene un prefijo (Estantería → EST, Nivel → NIV…).
--   * La parte propia del código de una ubicación que está dentro de otra es
--     el prefijo de su tipo más un número de dos cifras: EST03, NIV02. El
--     prefijo no se puede cambiar en la ubicación; el número sí.
--       ALM-A  ›  ALM-A-PAS01  ›  ALM-A-PAS01-EST03  ›  ALM-A-PAS01-EST03-NIV02
--   * Las ubicaciones de primer nivel (zonas) mantienen un código libre.
--   * Si se cambia el prefijo de un tipo, se recodifican todas las de ese tipo
--     y, con ellas, las de dentro.
--   * Las existentes que no siguen la regla se recodifican tras revisar la
--     lista en la aplicación, conservando su número (E01 → EST01).
-- =============================================================================

ALTER TABLE location_type
    ADD COLUMN code_prefix text,
    ADD COLUMN sort_order integer NOT NULL DEFAULT 100;

UPDATE location_type SET code_prefix = x.prefix, sort_order = x.ord
  FROM (VALUES
    ('ZONA', 'ZON', 10), ('AREA', 'ARE', 15), ('PASILLO', 'PAS', 20), ('ESTANTERIA', 'EST', 30),
    ('ARMARIO', 'ARM', 35), ('CAJONERA', 'CJN', 40), ('NIVEL', 'NIV', 50), ('CAJON', 'CJO', 55),
    ('POSICION', 'POS', 60)
  ) AS x (code, prefix, ord)
 WHERE location_type.code = x.code;

-- Tipos creados a mano: las tres primeras letras de su código, sin repetir.
DO $$
DECLARE
    t record;
    p text;
    i integer;
BEGIN
    FOR t IN SELECT id, code FROM location_type WHERE code_prefix IS NULL ORDER BY code LOOP
        p := left(regexp_replace(t.code, '[^A-Z]', '', 'g') || 'XXX', 3);
        i := 1;
        WHILE EXISTS (SELECT 1 FROM location_type WHERE code_prefix = p) LOOP
            p := left(p, 2) || chr(64 + i);
            i := i + 1;
        END LOOP;
        UPDATE location_type SET code_prefix = p WHERE id = t.id;
    END LOOP;
END $$;

ALTER TABLE location_type
    ALTER COLUMN code_prefix SET NOT NULL,
    ADD CONSTRAINT location_type_prefix_uq UNIQUE (code_prefix),
    ADD CONSTRAINT location_type_prefix_chk CHECK (code_prefix ~ '^[A-Z]{1,6}$');

-- Número propio de la ubicación dentro de su tipo (EST03 → 3). Las zonas y las
-- ubicaciones antiguas aún sin recodificar no lo tienen.
ALTER TABLE storage_location
    ADD COLUMN seq integer,
    ADD CONSTRAINT storage_location_seq_chk CHECK (seq IS NULL OR seq BETWEEN 1 AND 9999);

-- La parte propia se calcula: prefijo del tipo + número con al menos dos cifras.
CREATE FUNCTION sga_location_segment() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_prefix text;
BEGIN
    IF NEW.seq IS NOT NULL THEN
        IF NEW.parent_id IS NULL THEN
            RAISE EXCEPTION 'Las ubicaciones de primer nivel tienen código libre, sin número' USING ERRCODE = 'SG016';
        END IF;
        SELECT code_prefix INTO v_prefix FROM location_type WHERE id = NEW.location_type_id;
        NEW.segment := v_prefix || lpad(NEW.seq::text, greatest(2, length(NEW.seq::text)), '0');
    END IF;
    RETURN NEW;
END $$;

-- Se ejecuta antes que storage_location_code (los disparadores van por orden alfabético).
CREATE TRIGGER storage_location_build_segment
    BEFORE INSERT OR UPDATE OF seq, location_type_id, parent_id ON storage_location
    FOR EACH ROW EXECUTE FUNCTION sga_location_segment();

-- El código completo también se recalcula si cambia el número o el tipo.
DROP TRIGGER storage_location_code ON storage_location;
CREATE TRIGGER storage_location_code
    BEFORE INSERT OR UPDATE OF segment, parent_id, seq, location_type_id ON storage_location
    FOR EACH ROW EXECUTE FUNCTION sga_location_code();

-- Si cambia el prefijo de un tipo, se recodifican las ubicaciones de ese tipo
-- (y, por la regla de la migración 0007, las de dentro).
CREATE FUNCTION sga_location_type_prefix() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE storage_location SET seq = seq, updated_at = now()
     WHERE location_type_id = NEW.id AND seq IS NOT NULL;
    RETURN NULL;
END $$;

CREATE TRIGGER location_type_prefix
    AFTER UPDATE OF code_prefix ON location_type
    FOR EACH ROW WHEN (OLD.code_prefix IS DISTINCT FROM NEW.code_prefix)
    EXECUTE FUNCTION sga_location_type_prefix();

-- Activar o desactivar ubicaciones: solo administradores (decidido el 15/11/2026).
-- Una ubicación desactivada no desaparece: se sigue viendo, en gris.
INSERT INTO permission (code, description) VALUES
    ('location.deactivate', 'Activar y desactivar ubicaciones');
INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id FROM role r, permission p WHERE r.code = 'ADMIN_TECNICO' AND p.code = 'location.deactivate';
