-- =============================================================================
-- IDOM ADA · Migración 0011 · Tipos de contenido
--
-- Decisiones del 15/11/2026:
--   * Lo que se guarda en el almacén pasa a llamarse «contenido». Los
--     materiales son un tipo de contenido; de partida hay Material,
--     Herramienta, Equipo y Consumible, editables en «Tipos».
--   * Cada tipo tiene su prefijo de código: MAT-000001, HER-000002...
--     El número sale de una única secuencia, así no se repite entre tipos.
--   * Los contenidos existentes se recodifican al prefijo de su tipo si su
--     código era automático (MAT-000123). Los códigos puestos a mano se
--     respetan.
--   * Por dentro la tabla sigue siendo `material`: solo cambia lo que se ve.
-- =============================================================================

CREATE TABLE content_type (
    code             text PRIMARY KEY,
    name             text NOT NULL UNIQUE,
    code_prefix      text NOT NULL UNIQUE,
    default_tracking text NOT NULL DEFAULT 'EXACT',
    default_loanable boolean NOT NULL DEFAULT false,
    sort_order       integer NOT NULL DEFAULT 0,
    active           boolean NOT NULL DEFAULT true,
    CONSTRAINT content_type_code_chk CHECK (code ~ '^[A-Z][A-Z0-9_]{1,29}$'),
    CONSTRAINT content_type_prefix_chk CHECK (code_prefix ~ '^[A-Z]{2,5}$'),
    CONSTRAINT content_type_tracking_chk CHECK (default_tracking IN ('EXACT', 'ESTIMATED', 'NOT_TRACKED'))
);

-- CSM y no CON para Consumible: CON ya es el prefijo de «Contenedor genérico».
INSERT INTO content_type (code, name, code_prefix, default_tracking, default_loanable, sort_order) VALUES
    ('MATERIAL',    'Material',    'MAT', 'EXACT',       false, 1),
    ('HERRAMIENTA', 'Herramienta', 'HER', 'EXACT',       true,  2),
    ('EQUIPO',      'Equipo',      'EQU', 'EXACT',       true,  3),
    ('CONSUMIBLE',  'Consumible',  'CSM', 'NOT_TRACKED', false, 4);

ALTER TABLE material
    ADD COLUMN content_type_code text NOT NULL DEFAULT 'MATERIAL' REFERENCES content_type (code);
CREATE INDEX material_content_type_idx ON material (content_type_code);

-- Lo que hasta ahora se prestaba eran herramientas.
UPDATE material SET content_type_code = 'HERRAMIENTA' WHERE is_loanable;

-- Recodificar los códigos automáticos al prefijo de su tipo (sin pisar ninguno existente).
UPDATE material m
   SET internal_ref = t.code_prefix || substr(m.internal_ref, 4), updated_at = now()
  FROM content_type t
 WHERE t.code = m.content_type_code
   AND t.code_prefix <> 'MAT'
   AND m.internal_ref ~ '^MAT-[0-9]{6}$'
   AND NOT EXISTS (SELECT 1 FROM material x WHERE x.internal_ref = t.code_prefix || substr(m.internal_ref, 4));
