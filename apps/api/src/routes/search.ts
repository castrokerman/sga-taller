import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { requireAuth } from '../auth/guard.js';

/**
 * Buscador general por palabras: materiales, contenedores y ubicaciones.
 * Una cosa coincide si contiene todas las palabras escritas, en cualquier orden,
 * sin importar mayúsculas ni tildes. Cada resultado dice dónde está.
 */

// Quita tildes y pasa a minúsculas, en SQL y en la búsqueda.
const FOLD = (expr: string) =>
  `translate(lower(${expr}), 'áàäâéèëêíìïîóòöôúùüûñç', 'aaaaeeeeiiiioooouuuunc')`;
const fold = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[%_\\]/g, '');

/** Condición «contiene todas las palabras» sobre un texto; las palabras van desde $2. */
const allWords = (text: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${FOLD(text)} LIKE '%' || $${i + 2} || '%'`).join(' AND ');

export function searchRoutes(app: FastifyInstance, deps: { pool: pg.Pool }) {
  const { pool } = deps;

  app.get(
    '/api/search',
    {
      preHandler: requireAuth(),
      schema: {
        querystring: {
          type: 'object', required: ['q'], additionalProperties: false,
          properties: { q: { type: 'string', minLength: 1, maxLength: 100 }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 } },
        },
      },
    },
    async (request) => {
      const { q, limit } = request.query as { q: string; limit: number };
      const words = fold(q).split(/\s+/).filter((w) => w.length > 0).slice(0, 8);
      const perms = new Set(request.user!.permissions);
      if (words.length === 0) return { materials: [], containers: [], locations: [] };
      const params = [limit, ...words];

      const materials = perms.has('material.read')
        ? (
            await pool.query(
              `WITH m AS (
                 SELECT m.id, m.internal_ref AS "internalRef", m.description, m.unit_code AS "unitCode",
                        m.quantity_tracking AS "quantityTracking", m.status, f.name AS "familyName",
                        (SELECT ph.id FROM photo ph WHERE ph.entity_type = 'material' AND ph.entity_id = m.id ORDER BY ph.position LIMIT 1) AS "photoId",
                        concat_ws(' ', m.internal_ref, m.description, m.manufacturer, m.manufacturer_ref, m.material_spec,
                                  m.quality_grade, m.dimensions, m.notes, f.name,
                                  (SELECT string_agg(l.lot_code, ' ') FROM material_lot l WHERE l.material_id = m.id)) AS txt
                   FROM material m JOIN material_family f ON f.id = m.family_id
               )
               SELECT m.id, m."internalRef", m.description, m."unitCode", m."quantityTracking", m.status, m."familyName", m."photoId",
                      ${perms.has('stock.read') ? `coalesce((
                        SELECT json_agg(json_build_object(
                                 'containerId', b.container_id, 'locationId', b.location_id,
                                 'placeCode', coalesce(k.code, sl.code), 'locationCode', el.code,
                                 'quantity', b.quantity::float) ORDER BY b.quantity DESC NULLS LAST)
                          FROM stock_balance b
                          LEFT JOIN container k ON k.id = b.container_id
                          LEFT JOIN storage_location sl ON sl.id = b.location_id
                          LEFT JOIN container_effective_location e ON e.container_id = b.container_id
                          LEFT JOIN storage_location el ON el.id = coalesce(e.location_id, b.location_id)
                         WHERE b.material_id = m.id), '[]')` : `'[]'::json`} AS places
                 FROM m
                WHERE ${allWords('m.txt', words.length)}
                ORDER BY (m.status = 'ACTIVE') DESC, (${FOLD('m.description')} LIKE $2 || '%') DESC, m.description
                LIMIT $1`,
              params,
            )
          ).rows
        : [];

      const containers = perms.has('container.read')
        ? (
            await pool.query(
              `SELECT c.id, c.code, c.description, t.name AS "typeName", c.status,
                      el.code AS "locationCode", el.id AS "locationId", p.code AS "parentCode", c.parent_container_id AS "parentContainerId",
                      (SELECT ph.id FROM photo ph WHERE ph.entity_type = 'container' AND ph.entity_id = c.id ORDER BY ph.position LIMIT 1) AS "photoId"
                 FROM container c
                 JOIN container_type t ON t.id = c.container_type_id
                 LEFT JOIN container p ON p.id = c.parent_container_id
                 LEFT JOIN container_effective_location e ON e.container_id = c.id
                 LEFT JOIN storage_location el ON el.id = e.location_id
                WHERE ${allWords(`concat_ws(' ', c.code, c.description, t.name)`, words.length)}
                ORDER BY (c.status = 'ACTIVE') DESC, c.code
                LIMIT $1`,
              params,
            )
          ).rows
        : [];

      const locations = perms.has('location.read')
        ? (
            await pool.query(
              `SELECT l.id, l.code, l.name, t.name AS "typeName", l.active, p.code AS "parentCode",
                      (SELECT ph.id FROM photo ph WHERE ph.entity_type = 'location' AND ph.entity_id = l.id ORDER BY ph.position LIMIT 1) AS "photoId"
                 FROM storage_location l
                 JOIN location_type t ON t.id = l.location_type_id
                 LEFT JOIN storage_location p ON p.id = l.parent_id
                WHERE ${allWords(`concat_ws(' ', l.code, l.name, l.description, t.name)`, words.length)}
                ORDER BY l.active DESC, l.code
                LIMIT $1`,
              params,
            )
          ).rows
        : [];

      return { materials, containers, locations };
    },
  );
}
