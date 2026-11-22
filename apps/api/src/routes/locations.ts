import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { writeAudit } from '../audit.js';
import { requirePermission } from '../auth/guard.js';
import { withTransaction } from '../db/tx.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { idempotent } from '../idempotency.js';
import { incrementCode, incrementName } from '../warehouse/codes.js';
import { CONTAINER_SELECT, LOCATION_SELECT, locationPath } from '../warehouse/queries.js';
import { newQrToken } from '../warehouse/tokens.js';
import { recordContainerMove } from '../warehouse/containers.js';
import { applyLine, createMovement, deleteBalance, getMaterial } from '../inventory/stock.js';

const CODE_PATTERN = '^[A-Z0-9][A-Z0-9-]{0,79}$';
/** Parte propia del código: letras, números y guiones en medio. */
const SEGMENT_PATTERN = '^[A-Z0-9]([A-Z0-9-]{0,38}[A-Z0-9])?$';
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

async function parentCode(db: pg.Pool | pg.PoolClient, parentId: string | null | undefined): Promise<string | null> {
  if (!parentId) return null;
  const r = await db.query(`SELECT code FROM storage_location WHERE id = $1`, [parentId]);
  return r.rows[0]?.code ?? null;
}

/**
 * Parte propia del código a partir de lo recibido: la parte (segment) o, por
 * compatibilidad, el código completo, que debe empezar por el de la superior.
 */
async function resolveSegment(
  db: pg.Pool | pg.PoolClient,
  body: { code?: string; segment?: string },
  parentId: string | null | undefined,
): Promise<string> {
  const prefix = await parentCode(db, parentId);
  let segment: string;
  if (body.segment !== undefined) {
    segment = body.segment.trim().toUpperCase();
  } else if (prefix && body.code !== undefined) {
    if (!body.code.startsWith(`${prefix}-`) || body.code.length <= prefix.length + 1) {
      throw badRequest(`El código tiene que empezar por ${prefix}-`, 'CODIGO_NO_VALIDO');
    }
    segment = body.code.slice(prefix.length + 1);
  } else {
    segment = (body.code ?? '').trim().toUpperCase();
  }
  if (!new RegExp(SEGMENT_PATTERN).test(segment)) {
    throw badRequest('El código solo admite letras mayúsculas, números y guiones en medio', 'CODIGO_NO_VALIDO');
  }
  return segment;
}

const fullCode = (prefix: string | null, segment: string) => (prefix ? `${prefix}-${segment}` : segment);

/** Código interno de un tipo a partir de su nombre: «Balda alta» → BALDA_ALTA. */
const typeCodeFrom = (name: string) =>
  name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'TIPO';

/** Parte propia de una ubicación con número: prefijo del tipo y al menos dos cifras (EST03). */
export const seqSegment = (typePrefix: string, seq: number) => `${typePrefix}${String(seq).padStart(2, '0')}`;

async function typeInfo(db: pg.Pool | pg.PoolClient, typeIdOrCode: { id?: string; code?: string }) {
  const r = typeIdOrCode.id
    ? await db.query(`SELECT id, code, name, code_prefix AS prefix FROM location_type WHERE id = $1`, [typeIdOrCode.id])
    : await db.query(`SELECT id, code, name, code_prefix AS prefix FROM location_type WHERE code = $1 AND active`, [typeIdOrCode.code]);
  if (!r.rows[0]) throw badRequest('El tipo de ubicación no existe o está desactivado', 'TIPO_NO_EXISTE');
  return r.rows[0] as { id: string; code: string; name: string; prefix: string };
}

/** El primer número libre para ese tipo dentro de esa ubicación. */
async function nextSeq(db: pg.Pool | pg.PoolClient, parentId: string, type: { id: string; prefix: string }, exceptId: string | null = null) {
  const r = await db.query(
    `SELECT coalesce(max(seq), 0)::int AS n FROM storage_location WHERE parent_id = $1 AND location_type_id = $2 AND id IS DISTINCT FROM $3`,
    [parentId, type.id, exceptId],
  );
  const prefix = await parentCode(db, parentId);
  let seq = r.rows[0].n + 1;
  // Por si alguna ubicación antigua sin recodificar ya usa ese código.
  while (await codeExistsExcept(db, fullCode(prefix, seqSegment(type.prefix, seq)), exceptId)) seq++;
  return seq;
}

async function codeExistsExcept(db: pg.Pool | pg.PoolClient, code: string, exceptId: string | null) {
  return Boolean((await db.query(`SELECT 1 FROM storage_location WHERE code = $1 AND id IS DISTINCT FROM $2`, [code, exceptId])).rowCount);
}

/**
 * Número propio a partir de lo recibido: el número (seq) o, por compatibilidad,
 * una parte o un código que acaben en número (P01 → 1). Sin nada, el siguiente libre.
 */
async function resolveSeq(
  db: pg.Pool | pg.PoolClient,
  body: { seq?: number; segment?: string; code?: string },
  parentId: string,
  type: { id: string; prefix: string },
  exceptId: string | null = null,
): Promise<number> {
  if (body.seq !== undefined) return body.seq;
  const text = body.segment ?? body.code;
  if (text !== undefined) {
    const m = /(\d+)$/.exec(text.trim());
    if (!m || Number(m[1]) < 1 || Number(m[1]) > 9999) {
      throw badRequest(`El código de una ubicación dentro de otra es ${type.prefix} y un número`, 'CODIGO_NO_VALIDO');
    }
    return Number(m[1]);
  }
  return nextSeq(db, parentId, type, exceptId);
}

async function assertCodeFree(db: pg.Pool | pg.PoolClient, code: string, exceptId: string | null = null) {
  const r = await db.query(`SELECT 1 FROM storage_location WHERE code = $1 AND id IS DISTINCT FROM $2`, [code, exceptId]);
  if (r.rowCount) throw conflict(`Ya existe una ubicación con el código ${code}`, 'CODIGO_DUPLICADO');
}

/** Ubicaciones que cuelgan de la indicada, a cualquier profundidad. */
async function descendantTotal(db: pg.Pool | pg.PoolClient, id: string): Promise<number> {
  const r = await db.query(
    `WITH RECURSIVE down AS (
       SELECT id FROM storage_location WHERE parent_id = $1
       UNION ALL SELECT l.id FROM storage_location l JOIN down ON l.parent_id = down.id)
     SELECT count(*)::int AS n FROM down`,
    [id],
  );
  return r.rows[0].n;
}

async function assertParent(db: pg.PoolClient, parentId: string | null | undefined) {
  if (!parentId) return;
  const r = await db.query(`SELECT active FROM storage_location WHERE id = $1`, [parentId]);
  if (!r.rowCount) throw badRequest('La ubicación superior no existe', 'UBICACION_NO_EXISTE');
  if (!r.rows[0].active) throw conflict('La ubicación superior está desactivada', 'UBICACION_INACTIVA');
}

/** Qué tipos de contenedor admite un tipo de ubicación (vacío: cualquiera). */
async function setAllowed(c: pg.PoolClient, locationTypeId: string, codes: string[]) {
  const ids = await c.query(`SELECT id FROM container_type WHERE code = ANY($1)`, [codes]);
  if (ids.rowCount !== codes.length) throw badRequest('Alguno de los tipos de contenedor no existe', 'TIPO_NO_EXISTE');
  await c.query(`DELETE FROM location_type_container_type WHERE location_type_id = $1`, [locationTypeId]);
  for (const r of ids.rows) {
    await c.query(`INSERT INTO location_type_container_type (location_type_id, container_type_id) VALUES ($1, $2)`, [locationTypeId, r.id]);
  }
}

export function locationRoutes(app: FastifyInstance, deps: { pool: pg.Pool }) {
  const { pool } = deps;

  // ---- Tipos de ubicación -------------------------------------------------
  app.get('/api/location-types', { preHandler: requirePermission('location.read') }, async () => {
    const r = await pool.query(
      `SELECT t.code, t.name, t.active, t.code_prefix AS "codePrefix", t.sort_order AS "sortOrder",
              t.holds_content AS "holdsContent",
              coalesce((SELECT array_agg(ct.code ORDER BY ct.name) FROM location_type_container_type x
                          JOIN container_type ct ON ct.id = x.container_type_id WHERE x.location_type_id = t.id), '{}') AS "allowedContainerTypes",
              (SELECT count(*)::int FROM storage_location l WHERE l.location_type_id = t.id) AS "locationCount"
         FROM location_type t ORDER BY t.sort_order, t.name`,
    );
    return { types: r.rows };
  });

  app.get(
    '/api/locations/next-code',
    {
      preHandler: requirePermission('location.read'),
      schema: {
        querystring: {
          type: 'object', required: ['parentId', 'typeCode'], additionalProperties: false,
          properties: { parentId: uuid, typeCode: { type: 'string', maxLength: 30 }, exceptId: uuid },
        },
      },
    },
    async (request) => {
      const q = request.query as { parentId: string; typeCode: string; exceptId?: string };
      const type = await typeInfo(pool, { code: q.typeCode });
      const seq = await nextSeq(pool, q.parentId, type, q.exceptId ?? null);
      const prefix = await parentCode(pool, q.parentId);
      return { parentCode: prefix, typePrefix: type.prefix, seq, code: fullCode(prefix, seqSegment(type.prefix, seq)) };
    },
  );

  app.post(
    '/api/location-types',
    {
      preHandler: requirePermission('admin.masterdata.manage'),
      schema: {
        body: {
          type: 'object', required: ['name', 'codePrefix'], additionalProperties: false,
          properties: {
            code: { type: 'string', pattern: TYPE_CODE_PATTERN },
            name: { type: 'string', minLength: 1, maxLength: 60 },
            codePrefix: { type: 'string', pattern: '^[A-Z]{1,6}$' },
            holdsContent: { type: 'boolean' },
            allowedContainerTypes: { type: 'array', maxItems: 100, uniqueItems: true, items: { type: 'string', maxLength: 30 } },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { code?: string; name: string; codePrefix: string; holdsContent?: boolean; allowedContainerTypes?: string[] };
      const code = body.code ?? typeCodeFrom(body.name);
      const exists = await pool.query(`SELECT code, code_prefix FROM location_type WHERE code = $1 OR code_prefix = $2`, [code, body.codePrefix]);
      if (exists.rowCount) {
        throw conflict(
          exists.rows[0].code_prefix === body.codePrefix ? `El prefijo ${body.codePrefix} ya lo usa otro tipo` : 'Ya existe un tipo de ubicación con ese nombre',
          'TIPO_DUPLICADO',
        );
      }
      await withTransaction(pool, async (c) => {
        const r = await c.query(`INSERT INTO location_type (code, name, code_prefix, holds_content, sort_order) VALUES ($1, $2, $3, $4, (SELECT coalesce(max(sort_order), 0) + 1 FROM location_type)) RETURNING id`, [
          code, body.name.trim(), body.codePrefix, body.holdsContent ?? false,
        ]);
        if (body.allowedContainerTypes) await setAllowed(c, r.rows[0].id, body.allowedContainerTypes);
      });
      await writeAudit(pool, {
        userId: request.user!.id, action: 'tipo_ubicacion.alta', entityType: 'location_type', entityId: code,
        after: { ...body, code }, ip: request.ip, requestId: request.id,
      });
      reply.code(201);
      return { type: { code, name: body.name.trim(), codePrefix: body.codePrefix, active: true, locationCount: 0 } };
    },
  );

  // Cambiar el prefijo recodifica las ubicaciones de ese tipo y las de dentro.
  app.patch(
    '/api/location-types/:code',
    {
      preHandler: requirePermission('admin.masterdata.manage'),
      schema: {
        params: { type: 'object', required: ['code'], properties: { code: { type: 'string', maxLength: 30 } } },
        body: {
          type: 'object', additionalProperties: false, minProperties: 1,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 60 },
            codePrefix: { type: 'string', pattern: '^[A-Z]{1,6}$' },
            active: { type: 'boolean' },
            holdsContent: { type: 'boolean' },
            allowedContainerTypes: { type: 'array', maxItems: 100, uniqueItems: true, items: { type: 'string', maxLength: 30 } },
          },
        },
      },
    },
    async (request) => {
      const { code } = request.params as { code: string };
      const body = request.body as { name?: string; codePrefix?: string; active?: boolean; holdsContent?: boolean; allowedContainerTypes?: string[] };
      return withTransaction(pool, async (c) => {
        const before = (await c.query(`SELECT id, name, code_prefix, active FROM location_type WHERE code = $1 FOR UPDATE`, [code])).rows[0];
        if (!before) throw notFound('El tipo de ubicación no existe');
        if (body.codePrefix && body.codePrefix !== before.code_prefix) {
          const dup = await c.query(`SELECT name FROM location_type WHERE code_prefix = $1`, [body.codePrefix]);
          if (dup.rowCount) throw conflict(`El prefijo ${body.codePrefix} ya lo usa «${dup.rows[0].name}»`, 'TIPO_DUPLICADO');
        }
        const affected = body.codePrefix && body.codePrefix !== before.code_prefix
          ? (await c.query(
              `WITH RECURSIVE down AS (
                 SELECT id FROM storage_location WHERE location_type_id = $1 AND seq IS NOT NULL
                 UNION SELECT l.id FROM storage_location l JOIN down ON l.parent_id = down.id)
               SELECT count(*)::int AS n FROM down`, [before.id])).rows[0].n
          : 0;
        await c.query(
          `UPDATE location_type SET name = coalesce($2, name), code_prefix = coalesce($3, code_prefix), active = coalesce($4, active),
                  holds_content = coalesce($5, holds_content) WHERE id = $1`,
          [before.id, body.name?.trim() ?? null, body.codePrefix ?? null, body.active ?? null, body.holdsContent ?? null],
        );
        if (body.allowedContainerTypes) await setAllowed(c, before.id, body.allowedContainerTypes);
        await writeAudit(c, {
          userId: request.user!.id, action: 'tipo_ubicacion.modificacion', entityType: 'location_type', entityId: code,
          before: { name: before.name, codePrefix: before.code_prefix, active: before.active },
          after: { ...body, ubicacionesRecodificadas: affected }, ip: request.ip, requestId: request.id,
        });
        return { recoded: affected };
      });
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
          properties: { parentId: uuid, includeInactive: { type: 'boolean', default: true } },
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
      pool.query(`${LOCATION_SELECT} WHERE l.parent_id = $1 ORDER BY l.active DESC, l.code`, [id]),
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
          type: 'object', required: ['name', 'typeCode'], additionalProperties: false,
          properties: {
            code: { type: 'string', pattern: CODE_PATTERN },
            segment: { type: 'string', maxLength: 40 },
            seq: { type: 'integer', minimum: 1, maximum: 9999 },
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
        code?: string; segment?: string; seq?: number; name: string; description?: string; parentId?: string; typeCode: string;
        maxCapacity?: number; allowedHazardClasses?: string[]; restrictionsNote?: string;
      };
      if (!body.parentId && body.code === undefined && body.segment === undefined) throw badRequest('Indica el código', 'CODIGO_NO_VALIDO');
      const location = await withTransaction(pool, async (c) => {
        await assertParent(c, body.parentId);
        const type = await typeInfo(c, { code: body.typeCode });
        const prefix = await parentCode(c, body.parentId);
        let segment: string;
        let seq: number | null = null;
        if (body.parentId) {
          seq = await resolveSeq(c, body, body.parentId, type);
          segment = seqSegment(type.prefix, seq);
        } else {
          segment = await resolveSegment(c, body, null);
        }
        await assertCodeFree(c, fullCode(prefix, segment));
        const created = await c.query(
          `INSERT INTO storage_location
             (qr_token, segment, seq, name, description, parent_id, location_type_id, max_capacity,
              capacity_unit, allowed_hazard_classes, restrictions_note)
           VALUES ($1, $2, $10, $3, $4, $5, $6, $7, CASE WHEN $7::numeric IS NULL THEN NULL ELSE 'contenedores' END, $8, $9)
           RETURNING id`,
          [
            newQrToken(), segment, body.name.trim(), body.description?.trim() || null, body.parentId ?? null,
            type.id, body.maxCapacity ?? null, body.allowedHazardClasses ?? [],
            body.restrictionsNote?.trim() || null, seq,
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
    // Con todos los datos de cada ubicación y contenedor, para poder editarlos en tabla desde el árbol.
    // También las desactivadas: se ven en gris y no desaparecen.
    const locations = await pool.query(`${LOCATION_SELECT} ORDER BY l.code`);
    const canSeeContainers = request.user!.permissions.includes('container.read');
    const containers = canSeeContainers
      ? (await pool.query(`${CONTAINER_SELECT} WHERE c.status = 'ACTIVE' ORDER BY c.code`)).rows
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

      const prefix = await parentCode(pool, original.parentId);
      let segment: string;
      let seq: number | null = null;
      let typePrefix: string | null = null;
      if (original.parentId) {
        const type = await typeInfo(pool, { code: original.typeCode });
        const next = await nextSeq(pool, original.parentId, type);
        seq = next;
        typePrefix = type.prefix;
        segment = seqSegment(type.prefix, next);
      } else {
        segment = incrementCode(original.segment);
        for (let i = 0; i < 200 && (await codeExists(pool, fullCode(prefix, segment))); i++) segment = incrementCode(segment);
      }

      const descendants = await activeDescendants(pool, id);
      return {
        code: fullCode(prefix, segment),
        prefix,
        segment,
        typePrefix,
        seq,
        name: incrementName(original.name),
        descendantCount: descendants.length,
        // Lo de dentro hereda el código de la copia, así que siempre se puede copiar.
        childrenCopyable: descendants.length <= MAX_DUPLICATE_DESCENDANTS,
        blockingChildCode: null,
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
          type: 'object', required: ['name'], additionalProperties: false,
          properties: {
            code: { type: 'string', pattern: CODE_PATTERN },
            segment: { type: 'string', maxLength: 40 },
            seq: { type: 'integer', minimum: 1, maximum: 9999 },
            name: { type: 'string', minLength: 1, maxLength: 120 },
            includeChildren: { type: 'boolean', default: false },
          },
        },
      },
    },
    (request, reply) =>
      idempotent(pool, request, reply, async () => {
        const { id } = request.params as { id: string };
        const body = request.body as { code?: string; segment?: string; seq?: number; name: string; includeChildren: boolean };

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

          // Calcula y comprueba todos los códigos nuevos antes de crear nada:
          // lo de dentro conserva su parte y hereda el código de la copia.
          let segment: string;
          let seq: number | null = null;
          if (src.parent_id) {
            const type = await typeInfo(c, { id: src.location_type_id });
            seq = await resolveSeq(c, body, src.parent_id, type);
            segment = seqSegment(type.prefix, seq);
          } else {
            if (body.code === undefined && body.segment === undefined) throw badRequest('Indica el código', 'CODIGO_NO_VALIDO');
            segment = await resolveSegment(c, body, null);
          }
          const prefix = await parentCode(c, src.parent_id);
          const newCode = fullCode(prefix, segment);
          const plan = descendants.map((d) => ({ ...d, newCode: newCode + d.code.slice(src.code.length) }));
          const segs = new Map<string, string>(
            (await c.query(`SELECT id, segment FROM storage_location WHERE id = ANY($1)`, [descendants.map((d) => d.id)])).rows.map((r) => [r.id, r.segment]),
          );
          const parentNew = new Map<string, string>([[id, newCode]]);
          for (const d of plan) {
            d.newCode = `${parentNew.get(d.parent_id)}-${segs.get(d.id)}`;
            parentNew.set(d.id, d.newCode);
          }
          const newCodes = [newCode, ...plan.map((d) => d.newCode)];
          if (new Set(newCodes).size !== newCodes.length) {
            throw conflict('La copia repetiría algún código', 'CODIGO_DUPLICADO');
          }
          const taken = await c.query(`SELECT code FROM storage_location WHERE code = ANY($1) ORDER BY code LIMIT 1`, [newCodes]);
          if (taken.rowCount) {
            throw conflict(`Ya existe una ubicación con el código ${taken.rows[0].code}`, 'CODIGO_DUPLICADO');
          }

          const copy = async (row: Record<string, unknown>, seg: string, rowSeq: unknown, name: string, parentId: unknown) => {
            const r = await c.query(
              `INSERT INTO storage_location
                 (qr_token, segment, seq, name, description, parent_id, location_type_id, max_capacity,
                  capacity_unit, allowed_hazard_classes, restrictions_note)
               VALUES ($1, $2, $11, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
              [
                newQrToken(), seg, name, row.description, parentId, row.location_type_id, row.max_capacity,
                row.capacity_unit, row.allowed_hazard_classes, row.restrictions_note, rowSeq ?? null,
              ],
            );
            return r.rows[0].id as string;
          };

          const rootId = await copy(src, segment, seq, body.name.trim(), src.parent_id);
          const newIds = new Map<string, string>([[id, rootId]]);
          for (const d of plan) {
            const full = (await c.query(`SELECT * FROM storage_location WHERE id = $1`, [d.id])).rows[0];
            newIds.set(d.id, await copy(full, full.segment, full.seq, full.name, newIds.get(d.parent_id)));
          }

          await writeAudit(c, {
            userId: request.user!.id, action: 'ubicacion.duplicado', entityType: 'storage_location', entityId: rootId,
            after: { original: src.code, copia: newCode, ubicacionesDeDentro: plan.length },
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
            segment: { type: 'string', maxLength: 40 },
            seq: { type: 'integer', minimum: 1, maximum: 9999 },
            name: { type: 'string', minLength: 1, maxLength: 120 },
            description: { type: 'string', maxLength: 500 },
            parentId: { anyOf: [{ type: 'null' }, uuid] },
            typeCode: { type: 'string', maxLength: 30 },
            maxCapacity: { anyOf: [{ type: 'null' }, { type: 'integer', minimum: 1, maximum: 100000 }] },
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
      const location = await withTransaction(pool, (c) => updateLocation(c, request, id, body));
      return location;
    },
  );

  // ---- Meter lo suelto en una caja nueva ------------------------------------
  // Para ubicaciones que solo alojan contenedores y tienen contenido suelto de
  // antes: se crea una caja ahí y todo lo suelto pasa dentro (un traslado).
  app.post(
    '/api/locations/:id/box-loose',
    {
      preHandler: requirePermission('container.manage'),
      schema: {
        params: idParams,
        body: { type: 'object', additionalProperties: false, properties: { typeCode: { type: 'string', maxLength: 30, default: 'CAJA' }, description: { type: 'string', maxLength: 300 } } },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const b = request.body as { typeCode: string; description?: string };
      return withTransaction(pool, async (c) => {
        const loc = (await c.query(`SELECT code, active FROM storage_location WHERE id = $1`, [id])).rows[0];
        if (!loc) throw notFound('La ubicación no existe');
        const lines = (await c.query(
          `SELECT id, material_id, lot_id, quantity::float AS q FROM stock_balance WHERE location_id = $1 FOR UPDATE`,
          [id],
        )).rows as Array<{ id: string; material_id: string; lot_id: string | null; q: number | null }>;
        if (!lines.length) throw badRequest('Aquí no hay nada suelto', 'NADA_SUELTO');
        const t = (await c.query(
          `SELECT id, code_prefix, next_number, default_reuse_policy FROM container_type WHERE code = $1 AND active FOR UPDATE`,
          [b.typeCode],
        )).rows[0];
        if (!t) throw badRequest('El tipo de contenedor no existe', 'TIPO_NO_EXISTE');
        const code = `${t.code_prefix}-${String(t.next_number).padStart(6, '0')}`;
        const k = await c.query(
          `INSERT INTO container (qr_token, code, container_type_id, location_id, reuse_policy, description)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [newQrToken(), code, t.id, id, t.default_reuse_policy, b.description?.trim() || `Lo que había suelto en ${loc.code}`],
        );
        const boxId = k.rows[0].id as string;
        await c.query(`UPDATE container_type SET next_number = next_number + 1 WHERE id = $1`, [t.id]);
        await recordContainerMove(c, {
          userId: request.user!.id, containerId: boxId, fromLocationId: null, fromParentId: null,
          toLocationId: id, toParentId: null, reason: 'Alta del contenedor para lo que había suelto',
        });
        const mv = await createMovement(c, { type: 'TRANSFER', userId: request.user!.id, reason: `Meter lo suelto de ${loc.code} en ${code}` });
        let n = 1;
        for (const l of lines) {
          const m = await getMaterial(c, l.material_id);
          await applyLine(c, mv, n++, { material: m, lotId: l.lot_id, containerId: null, locationId: id, delta: l.q === null ? null : -l.q, presence: false });
          await applyLine(c, mv, n++, { material: m, lotId: l.lot_id, containerId: boxId, locationId: null, delta: l.q, presence: true });
        }
        // Se ha metido todo: lo que quede suelto (un estimado a cero) desaparece.
        // Lo reservado para un proyecto pasa con el contenido a la caja.
        for (const l of lines) {
          if (!(await c.query(`SELECT 1 FROM stock_balance WHERE id = $1`, [l.id])).rowCount) continue;
          await c.query(
            `UPDATE stock_allocation SET stock_balance_id = nb.id
               FROM stock_balance nb
              WHERE stock_allocation.stock_balance_id = $1
                AND nb.container_id = $2 AND nb.material_id = $3 AND nb.lot_id IS NOT DISTINCT FROM $4`,
            [l.id, boxId, l.material_id, l.lot_id],
          );
          await deleteBalance(c, l.id);
        }
        await writeAudit(c, {
          userId: request.user!.id, action: 'contenedor.alta', entityType: 'container', entityId: boxId,
          after: { code, en: loc.code, lineas_metidas: lines.length }, ip: request.ip, requestId: request.id,
        });
        return { containerId: boxId, code, lines: lines.length };
      });
    },
  );

  // ---- Eliminar -------------------------------------------------------------
  // Solo administradores y solo si no deja huella: sin nada dentro, sin
  // material, sin anotaciones y sin movimientos en su historial. Si tiene algo
  // de eso, se desactiva en su lugar.
  app.delete('/api/locations/:id', { preHandler: requirePermission('location.deactivate'), schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return withTransaction(pool, async (c) => {
      const r = await c.query(`SELECT code, name FROM storage_location WHERE id = $1 FOR UPDATE`, [id]);
      const loc = r.rows[0] as { code: string; name: string } | undefined;
      if (!loc) throw notFound('La ubicación no existe');
      const counts = (await c.query(
        `SELECT (SELECT count(*) FROM storage_location WHERE parent_id = $1)::int AS children,
                (SELECT count(*) FROM container WHERE location_id = $1)::int AS containers,
                (SELECT count(*) FROM stock_balance WHERE location_id = $1)::int AS stock,
                (SELECT count(*) FROM note WHERE entity_type = 'location' AND entity_id = $1)::int AS notes`,
        [id],
      )).rows[0];
      const why = [
        counts.children && `tiene ${counts.children} ${counts.children === 1 ? 'ubicación' : 'ubicaciones'} dentro`,
        counts.containers && `tiene ${counts.containers} contenedor${counts.containers === 1 ? '' : 'es'} (también los retirados cuentan)`,
        counts.stock && 'tiene contenido',
        counts.notes && 'tiene comentarios',
      ].filter(Boolean);
      if (why.length) {
        throw conflict(`No se puede eliminar ${loc.code}: ${why.join(', ')}. Vacíala antes o desactívala`, 'UBICACION_EN_USO');
      }
      await c.query(`DELETE FROM photo WHERE entity_type = 'location' AND entity_id = $1`, [id]);
      await c.query('SAVEPOINT borrar');
      try {
        await c.query(`DELETE FROM storage_location WHERE id = $1`, [id]);
      } catch (e) {
        if ((e as { code?: string }).code !== '23503') throw e;
        await c.query('ROLLBACK TO SAVEPOINT borrar');
        throw conflict(
          `No se puede eliminar ${loc.code}: tiene historial (movimientos, préstamos o recepciones). Desactívala para que no se use más`,
          'UBICACION_CON_HISTORIAL',
        );
      }
      await writeAudit(c, {
        userId: request.user!.id, action: 'ubicacion.baja', entityType: 'storage_location', entityId: id,
        before: { codigo: loc.code, nombre: loc.name }, ip: request.ip, requestId: request.id,
      });
      return { ok: true, code: loc.code };
    });
  });

  // ---- Edición de varias a la vez ------------------------------------------
  // Todo o nada: si una fila falla, no se guarda ninguna y se dice cuál.
  app.patch(
    '/api/locations/bulk',
    {
      preHandler: requirePermission('location.manage'),
      schema: {
        body: {
          type: 'object', required: ['items'], additionalProperties: false,
          properties: {
            items: {
              type: 'array', minItems: 1, maxItems: 500,
              items: {
                type: 'object', required: ['id'], additionalProperties: false, minProperties: 2,
                properties: {
                  id: uuid,
                  segment: { type: 'string', maxLength: 40 },
                  seq: { type: 'integer', minimum: 1, maximum: 9999 },
                  name: { type: 'string', minLength: 1, maxLength: 120 },
                  description: { type: 'string', maxLength: 500 },
                  typeCode: { type: 'string', maxLength: 30 },
                  maxCapacity: { anyOf: [{ type: 'null' }, { type: 'integer', minimum: 1, maximum: 100000 }] },
                  active: { type: 'boolean' },
                },
              },
            },
          },
        },
      },
    },
    async (request) => {
      const { items } = request.body as { items: Array<Record<string, unknown> & { id: string }> };
      if (new Set(items.map((i) => i.id)).size !== items.length) throw badRequest('Una ubicación aparece dos veces');
      return withTransaction(pool, async (c) => {
        const results = [];
        let recoded = 0;
        for (const { id, ...changes } of items) {
          try {
            const r = await updateLocation(c, request, id, changes);
            recoded += r.descendantsRecoded;
            results.push(r.location);
          } catch (e) {
            const code = (await c.query(`SELECT code FROM storage_location WHERE id = $1`, [id]).catch(() => null))?.rows[0]?.code;
            if (e instanceof AppError) throw new AppError(e.statusCode, e.code, `${code ?? 'Una ubicación'}: ${e.message}`);
            throw e;
          }
        }
        return { locations: results, descendantsRecoded: recoded };
      });
    },
  );

  // ---- Revisión de códigos ----------------------------------------------------
  // Ubicaciones cuyo código no sigue la regla «código de la superior + parte propia»,
  // con el código que les corresponde. Sirve para recodificar las creadas antes de la regla.
  app.get('/api/locations/recode-preview', { preHandler: requirePermission('location.read') }, async () => ({
    changes: await recodePlan(pool),
  }));

  app.post(
    '/api/locations/recode',
    { preHandler: requirePermission('location.manage') },
    (request, reply) =>
      idempotent(pool, request, reply, async () =>
        withTransaction(pool, async (c) => {
          await c.query(`LOCK TABLE storage_location IN SHARE ROW EXCLUSIVE MODE`);
          const plan = await recodePlan(c);
          const blocked = plan.find((p) => p.conflictWith);
          if (blocked) {
            throw conflict(`${blocked.code} pasaría a ${blocked.newCode}, que ya existe. Cambia antes una de las dos`, 'CODIGO_DUPLICADO');
          }
          // 1) Un código provisional único a las que van a recibir número, para que
          //    ningún cambio intermedio choque con otra ubicación.
          const numbered = plan.filter((p) => p.seq !== null);
          for (const p of numbered) {
            await c.query(`UPDATE storage_location SET seq = NULL, segment = 'TMP' || upper(left(md5(id::text), 12)) WHERE id = $1`, [p.id]);
          }
          // 2) De arriba abajo: su número definitivo. Las de dentro se recalculan solas.
          for (const p of numbered) await c.query(`UPDATE storage_location SET seq = $2 WHERE id = $1`, [p.id, p.seq]);
          for (const p of plan.filter((x) => x.seq === null)) {
            await c.query(`UPDATE storage_location SET segment = segment WHERE id = $1`, [p.id]);
          }
          const left = await recodePlan(c);
          if (left.length) throw conflict('No se han podido recodificar todas. Vuelve a intentarlo', 'RECODIFICACION_INCOMPLETA');
          await writeAudit(c, {
            userId: request.user!.id, action: 'ubicacion.recodificacion', entityType: 'storage_location',
            after: { cambios: plan.map((p) => `${p.code} → ${p.newCode}`) }, ip: request.ip, requestId: request.id,
          });
          return { recoded: plan.length };
        }),
      ),
  );
}

/**
 * Lo que cambiaría al aplicar la codificación completa, de arriba abajo:
 *   * cada ubicación lleva delante el código de la que la contiene;
 *   * las que están dentro de otra son prefijo de su tipo + número. A las que
 *     aún no tienen número se les da el de su código actual si está libre
 *     (E01 → EST01), y si no, el siguiente libre.
 * seq es el número que hay que ponerle, o null si no cambia.
 */
async function recodePlan(db: pg.Pool | pg.PoolClient) {
  const rows = (
    await db.query(
      `SELECT l.id, l.parent_id AS "parentId", l.code, l.segment, l.seq, l.location_type_id AS "typeId", t.code_prefix AS prefix
         FROM storage_location l JOIN location_type t ON t.id = l.location_type_id`,
    )
  ).rows as Array<{ id: string; parentId: string | null; code: string; segment: string; seq: number | null; typeId: string; prefix: string }>;

  const children = new Map<string | null, typeof rows>();
  for (const r of rows) children.set(r.parentId, [...(children.get(r.parentId) ?? []), r]);
  const collator = new Intl.Collator('es', { numeric: true });

  const plan: Array<{ id: string; code: string; newCode: string; depth: number; seq: number | null; conflictWith: string | null }> = [];
  const visit = (parentId: string | null, parentNewCode: string | null, depth: number) => {
    const kids = [...(children.get(parentId) ?? [])].sort((a, b) => collator.compare(a.code, b.code));
    // Números ya ocupados por tipo dentro de esta ubicación.
    const used = new Map<string, Set<number>>();
    const usedOf = (typeId: string) => used.get(typeId) ?? used.set(typeId, new Set()).get(typeId)!;
    for (const k of kids) if (k.seq !== null) usedOf(k.typeId).add(k.seq);
    for (const k of kids) {
      let seq: number | null = null;
      let segment = k.segment;
      if (parentId !== null && k.seq === null) {
        const taken = usedOf(k.typeId);
        const m = /(\d+)$/.exec(k.segment);
        let n = m ? Number(m[1]) : 0;
        if (!(n >= 1 && n <= 9999) || taken.has(n)) {
          n = 1;
          while (taken.has(n)) n++;
        }
        taken.add(n);
        seq = n;
        segment = seqSegment(k.prefix, n);
      } else if (parentId !== null && k.seq !== null) {
        segment = seqSegment(k.prefix, k.seq);
      }
      const newCode = fullCode(parentNewCode, segment);
      if (newCode !== k.code || seq !== null) plan.push({ id: k.id, code: k.code, newCode, depth, seq, conflictWith: null });
      visit(k.id, newCode, depth + 1);
    }
  };
  visit(null, null, 0);
  return plan.sort((a, b) => a.depth - b.depth || collator.compare(a.code, b.code));
}

/** Cambia una ubicación. Si cambia su código, cambian también los de las de dentro. */
async function updateLocation(c: pg.PoolClient, request: FastifyRequest, id: string, body: Record<string, unknown>) {
  const before = await getLocation(c, id);
  if (!before) throw notFound('La ubicación no existe');

  const parentId = 'parentId' in body ? (body.parentId as string | null) : before.parentId;
  if (body.parentId) {
    if (body.parentId === id) throw conflict('Una ubicación no puede colgar de sí misma', 'UBICACION_CICLICA');
    await assertParent(c, body.parentId as string);
  }
  // Activar o desactivar una ubicación es cosa del administrador.
  if ('active' in body && body.active !== before.active && !request.user!.permissions.includes('location.deactivate')) {
    throw forbidden('Solo un administrador puede activar o desactivar ubicaciones');
  }

  // Código: en las de primer nivel, libre; en las demás, prefijo del tipo + número.
  let segment: string | undefined;
  let seq: number | null | undefined;
  const codeTouched = ['segment', 'code', 'seq', 'parentId', 'typeCode'].some((k) => k in body);
  if (codeTouched) {
    if (!parentId) {
      segment = 'segment' in body || 'code' in body
        ? await resolveSegment(c, body as { code?: string; segment?: string }, null)
        : before.segment;
      seq = null;
    } else {
      const type = await typeInfo(c, 'typeCode' in body ? { code: body.typeCode as string } : { id: before.typeId });
      const typeOrPlaceChanged = 'typeCode' in body || 'parentId' in body;
      if ('seq' in body || 'segment' in body || 'code' in body) {
        seq = await resolveSeq(c, body as { seq?: number; segment?: string; code?: string }, parentId, type, id);
      } else if (before.seq !== null && before.parentId === parentId && !typeOrPlaceChanged) {
        seq = before.seq;
      } else if (before.seq !== null && before.parentId === parentId) {
        // Cambia de tipo en el mismo sitio: conserva su número si está libre.
        seq = (await codeExistsExcept(c, fullCode(await parentCode(c, parentId), seqSegment(type.prefix, before.seq)), id))
          ? await nextSeq(c, parentId, type, id)
          : before.seq;
      } else {
        // Cambia de sitio (o era antigua, sin número): conserva su número si está libre allí.
        const keep = before.seq ?? (/(\d+)$/.exec(before.segment) ? Number(/(\d+)$/.exec(before.segment)![1]) : null);
        seq = keep && keep <= 9999 && !(await codeExistsExcept(c, fullCode(await parentCode(c, parentId), seqSegment(type.prefix, keep)), id))
          ? keep
          : await nextSeq(c, parentId, type, id);
      }
      segment = seqSegment(type.prefix, seq!);
    }
    await assertCodeFree(c, fullCode(await parentCode(c, parentId), segment!), id);
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
  if ('parentId' in body) set('parent_id', body.parentId);
  if ('typeCode' in body) set('location_type_id', await typeId(c, body.typeCode as string));
  if (seq !== undefined && seq !== before.seq) set('seq', seq);
  // Sin número (zonas y antiguas), la parte se escribe tal cual.
  if (segment !== undefined && seq === null && segment !== before.segment) set('segment', segment);
  if ('name' in body) set('name', (body.name as string).trim());
  if ('description' in body) set('description', (body.description as string).trim() || null);
  if ('maxCapacity' in body) {
    set('max_capacity', body.maxCapacity);
    set('capacity_unit', body.maxCapacity === null ? null : 'contenedores');
  }
  if ('allowedHazardClasses' in body) set('allowed_hazard_classes', body.allowedHazardClasses);
  if ('restrictionsNote' in body) set('restrictions_note', (body.restrictionsNote as string).trim() || null);
  if ('active' in body) set('active', body.active);

  if (sets.length) {
    await c.query(`UPDATE storage_location SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, values);
  }

  const after = await getLocation(c, id);
  const descendantsRecoded = after.code !== before.code ? await descendantTotal(c, id) : 0;
  const pick = (l: Record<string, unknown>) => ({
    code: l.code, name: l.name, parentId: l.parentId, typeCode: l.typeCode,
    maxCapacity: l.maxCapacity, allowedHazardClasses: l.allowedHazardClasses, active: l.active,
  });
  await writeAudit(c, {
    userId: request.user!.id, action: 'ubicacion.modificacion', entityType: 'storage_location', entityId: id,
    before: pick(before), after: { ...pick(after), ...(descendantsRecoded ? { ubicacionesDeDentroRecodificadas: descendantsRecoded } : {}) },
    ip: request.ip, requestId: request.id,
  });
  return { location: after, descendantsRecoded };
}
