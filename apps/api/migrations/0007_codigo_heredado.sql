-- =============================================================================
-- IDOM ADA · Migración 0007 · Código de ubicación heredado
--
-- Decisión del 14/11/2026: el código de una ubicación es el de la ubicación
-- que la contiene más su parte final, que es lo único que se elige:
--
--   ALM-A  ›  ALM-A-P01  ›  ALM-A-P01-E03
--             (parte: P01)   (parte: E03)
--
-- Si cambia el código de una ubicación, cambian solos los de todas las que
-- lleva dentro. Las ubicaciones raíz no tienen prefijo: su parte es su código.
--
-- Las ubicaciones existentes que no siguen la regla NO se recodifican aquí:
-- la aplicación enseña la lista de cambios y se aplican cuando se confirman.
-- =============================================================================

ALTER TABLE storage_location ADD COLUMN segment text;

-- Parte final de cada ubicación existente:
--   * raíz: su código completo;
--   * si su código empieza por el de la superior y un guion: lo que sigue;
--   * si no: su código entero, para no perder nada. Al recodificarla quedará
--     el de la superior delante: COM › ARMARIO-QUIMICOS pasa a COM-ARMARIO-QUIMICOS.
UPDATE storage_location SET segment = code WHERE parent_id IS NULL;

UPDATE storage_location l
   SET segment = CASE
       WHEN left(l.code, length(p.code) + 1) = p.code || '-' AND length(l.code) > length(p.code) + 1
            THEN substr(l.code, length(p.code) + 2)
       ELSE l.code
   END
  FROM storage_location p
 WHERE p.id = l.parent_id;

ALTER TABLE storage_location
    ALTER COLUMN segment SET NOT NULL,
    ADD CONSTRAINT storage_location_segment_chk CHECK (length(segment) > 0);

COMMENT ON COLUMN storage_location.segment IS
    'Parte propia del código. El código completo es el de la ubicación superior, un guion y esta parte.';

-- El código completo se calcula siempre a partir de la superior.
CREATE FUNCTION sga_location_code() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    v_parent text;
BEGIN
    -- Alta indicando el código completo: se deduce la parte propia como arriba.
    IF NEW.segment IS NULL AND NEW.code IS NOT NULL THEN
        SELECT code INTO v_parent FROM storage_location WHERE id = NEW.parent_id;
        NEW.segment := CASE
            WHEN v_parent IS NULL THEN NEW.code
            WHEN left(NEW.code, length(v_parent) + 1) = v_parent || '-' AND length(NEW.code) > length(v_parent) + 1
                 THEN substr(NEW.code, length(v_parent) + 2)
            ELSE NEW.code
        END;
    END IF;
    IF NEW.parent_id IS NULL THEN
        NEW.code := NEW.segment;
    ELSE
        SELECT code INTO v_parent FROM storage_location WHERE id = NEW.parent_id;
        NEW.code := v_parent || '-' || NEW.segment;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER storage_location_code
    BEFORE INSERT OR UPDATE OF segment, parent_id ON storage_location
    FOR EACH ROW EXECUTE FUNCTION sga_location_code();

-- Si cambia el código, se recalculan los de las ubicaciones de dentro (y estas,
-- a su vez, los de las suyas).
CREATE FUNCTION sga_location_code_cascade() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    UPDATE storage_location SET segment = segment, updated_at = now() WHERE parent_id = NEW.id;
    RETURN NULL;
END $$;

CREATE TRIGGER storage_location_code_cascade
    AFTER UPDATE ON storage_location
    FOR EACH ROW WHEN (OLD.code IS DISTINCT FROM NEW.code)
    EXECUTE FUNCTION sga_location_code_cascade();

-- Corrección: hasta ahora, dejar vacío «Avisar si baja de» guardaba un 0 en vez
-- de nada. Un aviso en 0 no tiene sentido (nunca se baja de cero), así que se quita.
UPDATE material SET min_stock = NULL WHERE min_stock = 0;
