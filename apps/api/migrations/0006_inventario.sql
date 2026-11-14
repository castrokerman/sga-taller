-- =============================================================================
-- IDOM ADA · Migración 0006 · Inventario (Fase 3)
--
-- Decisiones del 14/11/2026:
--   * Se parte de cero: no hay inventario previo que importar.
--   * Sin gestión de retales de barra y chapa.
--   * Las familias de material las crean y cambian los responsables de almacén
--     y los administradores, y pueden tener subfamilias.
--   * Cualquier usuario puede retirar material, pero todo deja huella.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Familias con subfamilias
-- -----------------------------------------------------------------------------
ALTER TABLE material_family
    ADD COLUMN parent_id uuid REFERENCES material_family (id) ON DELETE RESTRICT,
    ADD COLUMN default_unit_code text REFERENCES unit_of_measure (code),
    ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX material_family_parent_idx ON material_family (parent_id);

-- Nombre único entre hermanas, sin distinguir mayúsculas.
CREATE UNIQUE INDEX material_family_name_uq
    ON material_family (coalesce(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

--   SG015 ciclo en la jerarquía de familias
CREATE FUNCTION sga_material_family_no_cycle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.parent_id IS NOT NULL AND EXISTS (
        WITH RECURSIVE up AS (
            SELECT id, parent_id FROM material_family WHERE id = NEW.parent_id
            UNION ALL
            SELECT f.id, f.parent_id FROM material_family f JOIN up ON f.id = up.parent_id
        )
        SELECT 1 FROM up WHERE id = NEW.id
    ) THEN
        RAISE EXCEPTION 'Una familia no puede quedar dentro de sí misma' USING ERRCODE = 'SG015';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER material_family_no_cycle
    BEFORE INSERT OR UPDATE OF parent_id ON material_family
    FOR EACH ROW EXECUTE FUNCTION sga_material_family_no_cycle();

UPDATE material_family SET default_unit_code = 'ud';
UPDATE material_family SET default_unit_code = 'l' WHERE code = 'QUIMICO';

-- -----------------------------------------------------------------------------
-- Materiales
-- -----------------------------------------------------------------------------
-- Referencia interna automática: MAT-000001, MAT-000002...
CREATE SEQUENCE material_ref_seq;
ALTER TABLE material
    ALTER COLUMN internal_ref SET DEFAULT 'MAT-' || lpad(nextval('material_ref_seq')::text, 6, '0'),
    ADD COLUMN min_stock numeric(18,4),
    ADD COLUMN notes text,
    ADD CONSTRAINT material_min_stock_chk CHECK (min_stock IS NULL OR min_stock >= 0);

-- -----------------------------------------------------------------------------
-- Existencias por material
-- -----------------------------------------------------------------------------
CREATE VIEW material_stock AS
SELECT m.id AS material_id,
       sum(b.quantity)                                          AS quantity,
       coalesce(sum(a.quantity_free), 0)                        AS quantity_free,
       count(b.id)                                              AS places,
       bool_or(b.needs_recount)                                 AS needs_recount
  FROM material m
  LEFT JOIN stock_balance b ON b.material_id = m.id
  LEFT JOIN stock_availability a ON a.stock_balance_id = b.id
 GROUP BY m.id;

-- -----------------------------------------------------------------------------
-- Un préstamo recuerda de dónde salió, para devolverlo al mismo sitio
-- -----------------------------------------------------------------------------
ALTER TABLE tool_loan
    ADD COLUMN container_id uuid REFERENCES container (id),
    ADD COLUMN location_id uuid REFERENCES storage_location (id);
