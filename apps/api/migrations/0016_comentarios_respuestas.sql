-- =============================================================================
-- IDOM ADA · Migración 0016 · Comentarios con respuestas
--
-- Decisión del 15/11/2026: las anotaciones pasan a llamarse comentarios, y se
-- puede responder a un comentario. Las respuestas cuelgan del comentario
-- original (un solo nivel), son del mismo elemento y, como los comentarios,
-- no se modifican ni se borran. Al responder se avisa a quien escribió el
-- comentario y a quienes ya han respondido.
-- =============================================================================

ALTER TABLE note ADD COLUMN parent_id uuid REFERENCES note (id);
CREATE INDEX note_parent_idx ON note (parent_id) WHERE parent_id IS NOT NULL;

UPDATE permission SET description = 'Escribir y responder comentarios' WHERE code = 'note.add';
