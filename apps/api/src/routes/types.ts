import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { writeAudit } from '../audit.js';
import { requirePermission } from '../auth/guard.js';
import { withTransaction } from '../db/tx.js';
import { badRequest, conflict, notFound } from '../errors.js';

/** Las tres familias de tipos que se editan en «Tipos». */
const KINDS = {
  location: {
    table: 'location_type', noun: 'ubicaciones',
    uses: `SELECT count(*)::int AS n FROM storage_location WHERE location_type_id = $1`,
    cleanup: [`DELETE FROM location_type_container_type WHERE location_type_id = $1`],
    key: 'id',
  },
  container: {
    table: 'container_type', noun: 'contenedores',
    uses: `SELECT count(*)::int AS n FROM container WHERE container_type_id = $1`,
    cleanup: [`DELETE FROM location_type_container_type WHERE container_type_id = $1`],
    key: 'id',
  },
  content: {
    table: 'content_type', noun: 'contenidos',
    uses: `SELECT count(*)::int AS n FROM material WHERE content_type_code = $1`,
    cleanup: [] as string[],
    key: 'code',
  },
} as const;
type Kind = keyof typeof KINDS;
const PATHS: Record<Kind, string> = { location: 'location-types', container: 'container-types', content: 'content-types' };

/**
 * Eliminar un tipo que nadie usa y reordenar los tipos a mano. Un tipo en uso
 * no se elimina (se desactiva): lo usan ubicaciones, contenedores o
 * contenidos, también los eliminados que conservan su historial.
 */
export function typeRoutes(app: FastifyInstance, deps: { pool: pg.Pool }) {
  const { pool } = deps;
  for (const kind of Object.keys(KINDS) as Kind[]) {
    const k = KINDS[kind];

    app.delete(
      `/api/${PATHS[kind]}/:code`,
      { preHandler: requirePermission('admin.masterdata.manage') },
      async (request) => {
        const { code } = request.params as { code: string };
        return withTransaction(pool, async (c) => {
          const t = (await c.query(`SELECT ${k.key} AS id, name FROM ${k.table} WHERE code = $1 FOR UPDATE`, [code])).rows[0];
          if (!t) throw notFound('El tipo no existe');
          const n = (await c.query(k.uses, [t.id])).rows[0].n as number;
          if (n > 0) {
            throw conflict(`No se puede eliminar «${t.name}»: lo usan ${n} ${k.noun}. Desactívalo para que no se use más`, 'TIPO_EN_USO');
          }
          for (const q of k.cleanup) await c.query(q, [t.id]);
          try {
            await c.query('SAVEPOINT borrar');
            await c.query(`DELETE FROM ${k.table} WHERE ${k.key} = $1`, [t.id]);
          } catch (e) {
            if ((e as { code?: string }).code !== '23503') throw e;
            throw conflict(`No se puede eliminar «${t.name}»: aún hay datos que lo usan. Desactívalo para que no se use más`, 'TIPO_EN_USO');
          }
          await writeAudit(c, {
            userId: request.user!.id, action: 'tipo.eliminar', entityType: k.table, entityId: t.id,
            before: { codigo: code, nombre: t.name }, ip: request.ip, requestId: request.id,
          });
          return { ok: true };
        });
      },
    );

    app.post(
      `/api/${PATHS[kind]}/order`,
      {
        preHandler: requirePermission('admin.masterdata.manage'),
        schema: {
          body: {
            type: 'object', required: ['codes'], additionalProperties: false,
            properties: { codes: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'string', maxLength: 40 } } },
          },
        },
      },
      async (request) => {
        const { codes } = request.body as { codes: string[] };
        if (new Set(codes).size !== codes.length) throw badRequest('Hay tipos repetidos en el orden', 'ORDEN_NO_VALIDO');
        return withTransaction(pool, async (c) => {
          const all = (await c.query(`SELECT code FROM ${k.table}`)).rows.map((r) => r.code as string);
          if (all.length !== codes.length || !all.every((x) => codes.includes(x))) {
            throw badRequest('El orden tiene que incluir todos los tipos', 'ORDEN_NO_VALIDO');
          }
          await c.query(
            `UPDATE ${k.table} t SET sort_order = x.n FROM unnest($1::text[]) WITH ORDINALITY AS x (code, n) WHERE t.code = x.code`,
            [codes],
          );
          await writeAudit(c, {
            userId: request.user!.id, action: 'tipo.reordenar', entityType: k.table,
            after: { orden: codes }, ip: request.ip, requestId: request.id,
          });
          return { ok: true };
        });
      },
    );
  }
}
