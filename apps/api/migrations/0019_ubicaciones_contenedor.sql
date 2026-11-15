-- =============================================================================
-- IDOM ADA · Migración 0019 · El contenido va siempre en un contenedor
--
-- Decisiones del 15/11/2026:
--   * El contenido está siempre dentro de un contenedor, salvo que esté
--     desplegado o prestado.
--   * Algunos tipos de ubicación son muebles que hacen de contenedor y guardan
--     contenido directamente (de partida, armario, cajonera y cajón). El resto
--     solo aloja contenedores. Se elige en «Tipos».
--   * Cada tipo de ubicación puede limitar qué tipos de contenedor admite (por
--     ejemplo, una zona de palets solo palets). Si no se limita, admite
--     cualquiera.
--   * Lo que ya estuviera suelto donde ahora no puede estar se avisa y se mete
--     en una caja nueva desde la propia ubicación.
-- =============================================================================

ALTER TABLE location_type ADD COLUMN holds_content boolean NOT NULL DEFAULT false;
UPDATE location_type SET holds_content = true WHERE code IN ('ARMARIO', 'CAJONERA', 'CAJON');

CREATE TABLE location_type_container_type (
    location_type_id  uuid NOT NULL REFERENCES location_type (id) ON DELETE CASCADE,
    container_type_id uuid NOT NULL REFERENCES container_type (id) ON DELETE CASCADE,
    PRIMARY KEY (location_type_id, container_type_id)
);

-- Un contenedor solo puede ponerse en una ubicación cuyo tipo lo admita.
CREATE FUNCTION sga_container_allowed() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    lt uuid;
BEGIN
    IF NEW.location_id IS NULL OR (TG_OP = 'UPDATE' AND NEW.location_id IS NOT DISTINCT FROM OLD.location_id
                                   AND NEW.container_type_id IS NOT DISTINCT FROM OLD.container_type_id) THEN
        RETURN NEW;
    END IF;
    SELECT location_type_id INTO lt FROM storage_location WHERE id = NEW.location_id;
    IF EXISTS (SELECT 1 FROM location_type_container_type WHERE location_type_id = lt)
       AND NOT EXISTS (SELECT 1 FROM location_type_container_type WHERE location_type_id = lt AND container_type_id = NEW.container_type_id) THEN
        RAISE EXCEPTION '%', (
            SELECT format('En %s (%s) no caben contenedores de tipo %s. Admite: %s',
                          l.code, t.name, (SELECT name FROM container_type WHERE id = NEW.container_type_id),
                          (SELECT string_agg(ct.name, ', ' ORDER BY ct.name) FROM location_type_container_type x
                             JOIN container_type ct ON ct.id = x.container_type_id WHERE x.location_type_id = lt))
              FROM storage_location l JOIN location_type t ON t.id = l.location_type_id WHERE l.id = NEW.location_id)
            USING ERRCODE = 'SG018';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER container_allowed_in_location
    BEFORE INSERT OR UPDATE OF location_id, container_type_id ON container
    FOR EACH ROW EXECUTE FUNCTION sga_container_allowed();
