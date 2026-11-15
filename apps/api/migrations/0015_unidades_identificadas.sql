-- =============================================================================
-- IDOM ADA · Migración 0015 · Herramientas y equipos por unidad
--
-- Decisiones del 15/11/2026:
--   * Hay tipos de contenido que se llevan por cantidad (Material,
--     Consumible) y tipos que se llevan por unidad (Herramienta, Equipo).
--     Se configura en «Tipos».
--   * En los tipos por unidad, cada contenido es UNA unidad física, con su
--     código, su QR y su número de serie (opcional). No puede haber varias
--     unidades con el mismo código: si llegan tres taladros iguales, son tres
--     contenidos (opción B: sin modelo; cada unidad es un contenido aparte).
--   * Todos los contenidos tienen token QR (por si su tipo pasa a ser por
--     unidad), pero solo los de tipos por unidad sacan etiqueta.
-- =============================================================================

ALTER TABLE content_type ADD COLUMN unit_tracked boolean NOT NULL DEFAULT false;
UPDATE content_type SET unit_tracked = true WHERE code IN ('HERRAMIENTA', 'EQUIPO');

ALTER TABLE material ADD COLUMN serial_number text;
ALTER TABLE material ADD COLUMN qr_token text;
UPDATE material SET qr_token = upper(replace(gen_random_uuid()::text, '-', ''));
ALTER TABLE material
    ALTER COLUMN qr_token SET DEFAULT upper(replace(gen_random_uuid()::text, '-', '')),
    ALTER COLUMN qr_token SET NOT NULL,
    ADD CONSTRAINT material_qr_token_key UNIQUE (qr_token);
CREATE TRIGGER material_qr_immutable BEFORE UPDATE OF qr_token ON material
    FOR EACH ROW EXECUTE FUNCTION sga_qr_token_immutable();

-- Un contenido de un tipo por unidad no puede tener más de una unidad, ni
-- sumando lo que hay en el almacén y lo que está prestado. Solo se comprueba
-- cuando algo aumenta: lo que ya hubiera de antes se separa desde su ficha.
CREATE FUNCTION sga_single_unit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    total numeric;
BEGIN
    IF TG_OP = 'UPDATE' AND NEW.quantity IS NOT DISTINCT FROM OLD.quantity THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND coalesce(NEW.quantity, 0) <= coalesce(OLD.quantity, 0) THEN
        RETURN NEW;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM material m JOIN content_type t ON t.code = m.content_type_code
                    WHERE m.id = NEW.material_id AND t.unit_tracked) THEN
        RETURN NEW;
    END IF;
    SELECT coalesce((SELECT sum(quantity) FROM stock_balance WHERE material_id = NEW.material_id), 0)
         + coalesce((SELECT sum(quantity) FROM tool_loan WHERE material_id = NEW.material_id AND status = 'OPEN'), 0)
      INTO total;
    IF total > 1 THEN
        RAISE EXCEPTION 'Cada herramienta o equipo es una unidad con su propio código: no puede haber dos con el mismo'
            USING ERRCODE = 'SG017';
    END IF;
    RETURN NEW;
END $$;

CREATE CONSTRAINT TRIGGER stock_balance_single_unit
    AFTER INSERT OR UPDATE OF quantity ON stock_balance
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION sga_single_unit();
