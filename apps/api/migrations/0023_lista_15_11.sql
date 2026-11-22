-- =============================================================================
-- IDOM ADA · Migración 0023 · Cambios de la lista del 15/11/2026
--
-- * El responsable de almacén también puede eliminar contenidos.
-- =============================================================================

INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id FROM role r, permission p WHERE r.code = 'RESP_ALMACEN' AND p.code = 'material.delete'
ON CONFLICT DO NOTHING;

-- * Los tipos de contenedor también se ordenan a mano (como los de ubicación y
--   contenido). Se parte del orden alfabético.
ALTER TABLE container_type ADD COLUMN sort_order integer NOT NULL DEFAULT 0;
UPDATE container_type t SET sort_order = x.n
  FROM (SELECT id, row_number() OVER (ORDER BY name) AS n FROM container_type) x WHERE x.id = t.id;

-- * Un préstamo puede ir asociado a un proyecto.
ALTER TABLE tool_loan ADD COLUMN project_id uuid REFERENCES project(id);
CREATE INDEX tool_loan_project_idx ON tool_loan (project_id) WHERE project_id IS NOT NULL;

-- * Las familias cuelgan de un tipo de contenido: el primer nivel son los tipos
--   (Material, Herramienta, Equipo, Consumible…) y debajo sus familias. Las
--   subfamilias heredan el tipo de su familia. Las que ya había se reparten
--   por su nombre; se puede cambiar en «Familias».
ALTER TABLE material_family ADD COLUMN content_type_code text REFERENCES content_type(code);
UPDATE material_family SET content_type_code = CASE code
    WHEN 'HERRAMIENTA' THEN 'HERRAMIENTA'
    WHEN 'MEDICION'    THEN 'EQUIPO'
    WHEN 'CONSUMIBLE'  THEN 'CONSUMIBLE'
    ELSE 'MATERIAL' END
 WHERE parent_id IS NULL;
WITH RECURSIVE down AS (
    SELECT id, content_type_code FROM material_family WHERE parent_id IS NULL
    UNION ALL
    SELECT f.id, down.content_type_code FROM material_family f JOIN down ON f.parent_id = down.id
)
UPDATE material_family f SET content_type_code = down.content_type_code FROM down WHERE down.id = f.id;
-- Si algún tipo de los de arriba no existe en esta instalación, sus familias pasan al primero.
UPDATE material_family SET content_type_code = (SELECT code FROM content_type ORDER BY sort_order, name LIMIT 1)
 WHERE content_type_code IS NULL OR content_type_code NOT IN (SELECT code FROM content_type);
ALTER TABLE material_family ALTER COLUMN content_type_code SET NOT NULL;

CREATE FUNCTION sga_family_type() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- Una subfamilia tiene siempre el tipo de su familia.
    IF NEW.parent_id IS NOT NULL THEN
        SELECT content_type_code INTO NEW.content_type_code FROM material_family WHERE id = NEW.parent_id;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER sga_family_type BEFORE INSERT OR UPDATE OF parent_id, content_type_code ON material_family
    FOR EACH ROW EXECUTE FUNCTION sga_family_type();

CREATE FUNCTION sga_family_type_down() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- Al cambiar el tipo de una familia, sus subfamilias la siguen.
    IF NEW.content_type_code IS DISTINCT FROM OLD.content_type_code THEN
        UPDATE material_family SET content_type_code = NEW.content_type_code
         WHERE parent_id = NEW.id AND content_type_code IS DISTINCT FROM NEW.content_type_code;
    END IF;
    RETURN NULL;
END $$;
CREATE TRIGGER sga_family_type_down AFTER UPDATE OF content_type_code ON material_family
    FOR EACH ROW EXECUTE FUNCTION sga_family_type_down();
