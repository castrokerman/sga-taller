import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { writeAudit } from '../audit.js';
import { requirePermission } from '../auth/guard.js';
import { withTransaction } from '../db/tx.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { idempotent } from '../idempotency.js';
import { incrementCode, incrementName, rebaseCode } from '../warehouse/codes.js';
import { CONTAINER_SELECT, LOCATION_SELECT, locationPath } from '../warehouse/queries.js';
import { newQrToken } from '../warehouse/tokens.js';

const CODE_PATTERN = '^[A-Z0-9][A-Z0-9-]{0,39}$';
const TYPE_CODE_PATTERN = '^[A-Z][A-Z0-9_]{1,29}$';
const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
/** Máximo de ubicaciones de dentro que se copian al duplicar con su contenido. */
const MAX_DUPLICATE_DESCENDANTS = 500;

interface Descendant {
  id: string;
  parent_id: string;
  code: string;
}

/** Ubicaciones activas que cuelgan de la indicada, de arriba abajo. */
async function activeDescendants(db: pg.Pool | pg.PoolClient, id: string): Promise<Descendant[]> {
  const r = await db.query(
    `WITH RECURSIVE down AS (
       SELECT id, parent_id, code, 1 AS depth FROM storage_location WHERE parent_id = $1 AND active
       UNION ALL
       SELECT l.id, l.parent_id, l.code, down.depth + 1
         FROM storage_location l JOIN down ON l.parent_id = down.id
        WHERE l.active
     )
     SELECT id, parent_id, code FROM down ORDER BY depth, code`,
    [id],
  );
  return r.rows;
}

async function codeExists(db: pg.Pool | pg.PoolClient, code: string): Promise<boolean> {
  return Boolean((await db.query(`SELECT 1 FROM storage_location WHERE code = $1`, [code])).rowCount);
}

async function getLocation(db: pg.Pool | pg.PoolClient, id: string) {
  const r = await db.query(`${LOCATION_SELECT} WHERE l.id = $1`, [id]);
  return r.rows[0];
}

async function typeId(db: pg.PoolClient, code: string): Promise<string> {
  const r = await db.query(`SELECT id FROM location_type WHERE code = $1 AND active`, [code]);
  if (!r.rowCount) throw badRequest('El tipo de ubicación no existe', 'TIPO_NO_EXISTE');
  return r.rows[0].id;
}

async function assertParent(db: pg.PoolClient, parentId: string | null | undefined) {
  if (!parentId) return;
  const r = await db.query(`SELECT active FROM storage_location WHERE id = $1`, [parentId]);
  if (!r.rowCount) throw badRequest('La ubicación superior no existe', 'UBICACION_NO_EXISTE');
  if (!r.rows[0].active) throw conflict('La ubicación superior está desactivada', 'UBICACION_INACTIVA');
}

export function locationRoutes(app: FastifyInstance, deps: { pool: pg.Pool }) {
  const { pool } = deps;

  // ---- Tipos de ubicación -------------------------------------------------
  app.get('/api/location-types', { preHandler: requirePermission('location.read') }, async () => {
    const r = await pool.query(`SELECT code, name, active FROM location_type ORDER BY name`);
    return { types: r.rows };
  });

  app.post(
    '/api/location-types',
    {
      preHandler: requirePermission('admin.masterdata.manage'),
      schema: {
        body: {
          type: 'object', required: ['code', 'name'], additionalProperties: false,
          properties: {
            code: { type: 'string', pattern: TYPE_CODE_PATTERN },
            name: { type: 'string', minLength: 1, maxLength: 60 },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { code: string; name: string };
      const exists = await pool.query(`SELECT 1 FROM location_type WHERE code = $1`, [body.code]);
      if (exists.rowCount) throw conflict('Ya existe un tipo de ubicación con ese código', 'TIPO_DUPLICADO');
      await pool.query(`INSERT INTO location_type (code, name) VALUES ($1, $2)`, [body.code, body.name.trim()]);
      await writeAudit(pool, {
        userId: request.user!.id, action: 'tipo_ubicacion.alta', entityType: 'location_type', entityId: body.code,
        after: body, ip: request.ip, requestId: request.id,
      });
      reply.code(201);
      return { type: { code: body.code, name: body.name.trim(), active: true } };
    },
  );

  // ---- Ubicaciones --------------------------------------------------------
  // Sin parentId devuelve las ubicaciones raíz; con parentId, sus hijas.
  app.get(
    '/api/locations',
    {
      preHandler: requirePermission('location.read'),
      schema: {
        querystring: {
          type: 'object', additionalProperties: false,
          properties: { parentId: uuid, includeInactive: { type: 'boolean', default: false } },
        },
      },
    },
    async (request) => {
      const q = request.query as { parentId?: string; includeInactive: boolean };
      const r = await pool.query(
        `${LOCATION_SELECT}
          WHERE l.parent_id IS NOT DISTINCT FROM $1::uuid AND (l.active OR $2)
          ORDER BY l.code`,
        [q.parentId ?? null, q.includeInactive],
      );
      return { locations: r.rows };
    },
  );

  app.get('/api/locations/:id', { preHandler: requirePermission('location.read'), schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const location = await getLocation(pool, id);
    if (!location) throw notFound('La ubicación no existe');
    const [path, children, containers] = await Promise.all([
      locationPath(pool, id),
      pool.query(`${LOCATION_SELECT} WHERE l.parent_id = $1 AND l.active ORDER BY l.code`, [id]),
      pool.query(`${CONTAINER_SELECT} WHERE c.location_id = $1 AND c.status = 'ACTIVE' ORDER BY c.code`, [id]),
    ]);
    return { location, path, children: children.rows, containers: containers.rows };
  });

  app.post(
    '/api/locations',
    {
      preHandler: requirePermission('location.manage'),
      schema: {
        body: {
          type: 'object', required: ['code', 'name', 'typeCode'], additionalProperties: false,
          properties: {
            code: { type: 'string', pattern: CODE_PATTERN },
            name: { type: 'string', minLength: 1, maxLength: 120 },
            description: { type: 'string', maxLength: 500 },
            parentId: uuid,
            typeCode: { type: 'string', maxLength: 30 },
            maxCapacity: { type: 'integer', minimum: 1, maximum: 100000 },
            allowedHazardClasses: { type: 'array', maxItems: 10, items: { type: 'string', pattern: '^[A-Z_]{2,20}$' } },
            restrictionsNote: { type: 'string', maxLength: 500 },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as {
        code: string; name: string; description?: string; parentId?: string; typeCode: string;
        maxCapacity?: number; allowedHazardClasses?: string[]; restrictionsNote?: string;
      };
      const location = await withTransaction(pool, async (c) => {
        const dup = await c.query(`SELECT 1 FROM storage_location WHERE code = $1`, [body.code]);
        if (dup.rowCount) throw conflict('Ya existe una ubicación con ese código', 'CODIGO_DUPLICADO');
        await assertParent(c, body.parentId);
        const created = await c.query(
          `INSERT INTO storage_location
             (qr_token, code, name, description, parent_id, location_type_id, max_capacity,
              capacity_unit, allowed_hazard_classes, restrictions_note)
           VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $7::numeric IS NULL THEN NULL ELSE 'contenedores' END, $8, $9)
           RETURNING id`,
          [
            newQrToken(), body.code, body.name.trim(), body.description?.trim() || null, body.parentId ?? null,
            await typeId(c, body.typeCode), body.maxCapacity ?? null, body.allowedHazardClasses ?? [],
            body.restrictionsNote?.trim() || null,
          ],
        );
        const result = await getLocation(c, created.rows[0].id);
        await writeAudit(c, {
          userId: request.user!.id, action: 'ubicacion.alta', entityType: 'storage_location', entityId: result.id,
          after: { code: result.code, name: result.name, typeCode: result.typeCode, parentId: result.parentId },
          ip: request.ip, requestId: request.id,
        });
        return result;
      });
      reply.code(201);
      return { location };
    },
  );

  // ---- Árbol completo -----------------------------------------------------
  // Todas las ubicaciones activas y, si el usuario puede verlos, todos los
  // contenedores activos, en listas planas: la web monta el árbol.
  app.get('/api/tree', { preHandler: requirePermission('location.read') }, async (request) => {
    const locations = await pool.query(
      `SELECT l.id, l.parent_id AS "parentId", l.code, l.name, t.name AS "typeName",
              l.max_capacity::float AS "maxCapacity",
              (SELECT count(*)::int FROM container c WHERE c.location_id = l.id AND c.status = 'ACTIVE') AS "containerCount",
              (SELECT count(*)::int FROM storage_location h WHERE h.parent_id = l.id AND h.active) AS "childCount"
         FROM storage_location l JOIN location_type t ON t.id = l.location_type_id
        WHERE l.active
        ORDER BY l.code`,
    );
    const canSeeContainers = request.user!.permissions.includes('container.read');
    const containers = canSeeContainers
      ? (
          await pool.query(
            `SELECT c.id, c.code, t.name AS "typeName", c.description,
                    c.location_id AS "locationId", c.parent_container_id AS "parentContainerId"
               FROM container c JOIN container_type t ON t.id = c.container_type_id
              WHERE c.status = 'ACTIVE'
              ORDER BY c.code`,
          )
        ).rows
      : [];
    return { locations: locations.rows, containers };
  });

  // ---- Duplicar -----------------------------------------------------------
  // Propuesta para el formulario: el siguiente código libre y cuántas ubicaciones
  // de dentro se copiarían.
  app.get(
    '/api/locations/:id/duplicate-proposal',
    { preHandler: requirePermission('location.manage'), schema: { params: idParams } },
    async (request) => {
      const { id } = request.params as { id: string };
      const original = await getLocation(pool, id);
      if (!original) throw notFound('La ubicación no existe');

      let code = incrementCode(original.code);
      for (let i = 0; i < 200 && (await codeExists(pool, code)); i++) code = incrementCode(code);

      const descendants = await activeDescendants(pool, id);
      const notRenamable = descendants.find((d) => !d.code.startsWith(original.code));
      return {
        code,
        name: incrementName(original.name),
        descendantCount: descendants.length,
        // Para copiar lo de dentro, sus códigos deben empezar por el del original.
        childrenCopyable: !notRenamable && descendants.length <= MAX_DUPLICATE_DESCENDANTS,
        blockingChildCode: notRenamable?.code ?? null,
      };
    },
  );

  // Crea una copia de la ubicación en el mismo sitio, con QR nuevo.
  // Con includeChildren copia también las ubicaciones de dentro (no los contenedores),
  // cambiando el comienzo de sus códigos: ALM-A-P01-E01-N02 → ALM-A-P01-E02-N02.
  app.post(
    '/api/locations/:id/duplicate',
    {
      preHandler: requirePermission('location.manage'),
      schema: {
        params: idParams,
        body: {
          type: 'object', required: ['code', 'name'], additionalProperties: false,
          properties: {
            code: { type: 'string', pattern: CODE_PATTERN },
            name: { type: 'string', minLength: 1, maxLength: 120 },
            includeChildren: { type: 'boolean', default: false },
          },
        },
      },
    },
    (request, reply) =>
      idempotent(pool, request, reply, async () => {
        const { id } = request.params as { id: string };
        const body = request.body as { code: string; name: string; includeChildren: boolean };

        const result = await withTransaction(pool, async (c) => {
          const original = await c.query(`SELECT * FROM storage_location WHERE id = $1`, [id]);
          const src = original.rows[0];
          if (!src) throw notFound('La ubicación no existe');
          if (!src.active) throw conflict('No se puede duplicar una ubicación desactivada', 'UBICACION_INACTIVA');
          await assertParent(c, src.parent_id);

          const descendants = body.includeChildren ? await activeDescendants(c, id) : [];
          if (descendants.length > MAX_DUPLICATE_DESCENDANTS) {
            throw conflict(
              `Tiene ${descendants.length} ubicaciones dentro; el máximo para duplicar de una vez es ${MAX_DUPLICATE_DESCENDANTS}`,
              'DEMASIADAS_UBICACIONES',
            );
          }

          // Calcula y comprueba todos los códigos nuevos antes de crear nada.
          const plan = descendants.map((d) => ({ ...d, newCode: rebaseCode(d.code, src.code, body.code) }));
          const stuck = plan.find((d) => d.newCode === null);
          if (stuck) {
            throw conflict(
              `La ubicación ${stuck.code} no empieza por ${src.code}, así que no se puede renombrar en la copia. Duplica sin lo de dentro o cambia su código`,
              'CODIGO_HIJO_NO_RENOMBRABLE',
            );
          }
          const newCodes = [body.code, ...plan.map((d) => d.newCode!)];
          if (new Set(newCodes).size !== newCodes.length) {
            throw conflict('La copia repetiría algún código', 'CODIGO_DUPLICADO');
          }
          const taken = await c.query(`SELECT code FROM storage_location WHERE code = ANY($1) ORDER BY code LIMIT 1`, [newCodes]);
          if (taken.rowCount) {
            throw conflict(`Ya existe una ubicación con el código ${taken.rows[0].code}`, 'CODIGO_DUPLICADO');
          }

          const copy = async (row: Record<string, unknown>, code: string, name: string, parentId: unknown) => {
            const r = await c.query(
              `INSERT INTO storage_location
                 (qr_token, code, name, description, parent_id, location_type_id, max_capacity,
                  capacity_unit, allowed_hazard_classes, restrictions_note)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
              [
                newQrToken(), code, name, row.description, parentId, row.location_type_id, row.max_capacity,
                row.capacity_unit, row.allowed_hazard_classes, row.restrictions_note,
              ],
            );
            return r.rows[0].id as string;
          };

          const rootId = await copy(src, body.code, body.name.trim(), src.parent_id);
          const newIds = new Map<string, string>([[id, rootId]]);
          for (const d of plan) {
            const full = (await c.query(`SELECT * FROM storage_location WHERE id = $1`, [d.id])).rows[0];
            newIds.set(d.id, await copy(full, d.newCode!, full.name, newIds.get(d.parent_id)));
          }

          await writeAudit(c, {
            userId: request.user!.id, action: 'ubicacion.duplicado', entityType: 'storage_location', entityId: rootId,
            after: { original: src.code, copia: body.code, ubicacionesDeDentro: plan.length },
            ip: request.ip, requestId: request.id,
          });
          return { location: await getLocation(c, rootId), created: 1 + plan.length };
        });

        reply.code(201);
        return result;
      }),
  );

  app.patch(
    '/api/locations/:id',
    {
      preHandler: requirePermission('location.manage'),
      schema: {
        params: idParams,
        body: {
          type: 'object', additionalProperties: false, minProperties: 1,
          properties: {
            code: { type: 'string', pattern: CODE_PATTERN },
            name: { type: 'string', minLength: 1, maxLength: 120 },
            description: { type: 'string', maxLength: 500 },
            parentId: { anyOf: [uuid, { type: 'null' }] },
            typeCode: { type: 'string', maxLength: 30 },
            maxCapacity: { anyOf: [{ type: 'integer', minimum: 1, maximum: 100000 }, { type: 'null' }] },
            allowedHazardClasses: { type: 'array', maxItems: 10, items: { type: 'string', pattern: '^[A-Z_]{2,20}$' } },
            restrictionsNote: { type: 'string', maxLength: 500 },
            active: { type: 'boolean' },
          },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = request.body as Record<string, unknown>;

      const location = await withTransaction(pool, async (c) => {
        const before = await getLocation(c, id);
        if (!before) throw notFound('La ubicación no existe');

        if (typeof body.code === 'string' && body.code !== before.code) {
          const dup = await c.query(`SELECT 1 FROM storage_location WHERE code = $1`, [body.code]);
          if (dup.rowCount) throw conflict('Ya existe una ubicación con ese código', 'CODIGO_DUPLICADO');
        }
        if (body.parentId) {
          if (body.parentId === id) throw conflict('Una ubicación no puede colgar de sí misma', 'UBICACION_CICLICA');
          await assertParent(c, body.parentId as string);
        }
        if (body.active === false && (before.childCount > 0 || before.containerCount > 0)) {
          throw conflict(
            'No se puede desactivar una ubicación que contiene otras ubicaciones o contenedores',
            'UBICACION_NO_VACIA',
          );
        }

        const sets: string[] = [];
        const values: unknown[] = [id];
        const set = (column: string, value: unknown) => {
          values.push(value);
          sets.push(`${column} = $${values.length}`);
        };
        if ('code' in body) set('code', body.code);
        if ('name' in body) set('name', (body.name as string).trim());
        if ('description' in body) set('description', (body.description as string).trim() || null);
        if ('parentId' in body) set('parent_id', body.parentId);
        if ('typeCode' in body) set('location_type_id', await typeId(c, body.typeCode as string));
        if ('maxCapacity' in body) {
          set('max_capacity', body.maxCapacity);
          set('capacity_unit', body.maxCapacity === null ? null : 'contenedores');
        }
        if ('allowedHazardClasses' in body) set('allowed_hazard_classes', body.allowedHazardClasses);
        if ('restrictionsNote' in body) set('restrictions_note', (body.restrictionsNote as string).trim() || null);
        if ('active' in body) set('active', body.active);

        await c.query(`UPDATE storage_location SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, values);

        const after = await getLocation(c, id);
        const pick = (l: Record<string, unknown>) => ({
          code: l.code, name: l.name, parentId: l.parentId, typeCode: l.typeCode,
          maxCapacity: l.maxCapacity, allowedHazardClasses: l.allowedHazardClasses, active: l.active,
        });
        await writeAudit(c, {
          userId: request.user!.id, action: 'ubicacion.modificacion', entityType: 'storage_location', entityId: id,
          before: pick(before), after: pick(after), ip: request.ip, requestId: request.id,
        });
        return after;
      });
      return { location };
    },
  );
}
