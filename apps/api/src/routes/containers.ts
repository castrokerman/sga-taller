import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { writeAudit } from '../audit.js';
import { requirePermission } from '../auth/guard.js';
import { withTransaction } from '../db/tx.js';
import { AppError, badRequest, conflict, notFound } from '../errors.js';
import { idempotent } from '../idempotency.js';
import { containerDetail, recordContainerMove } from '../warehouse/containers.js';
import { CONTAINER_SELECT, containerChain, descendantCount, getParameter } from '../warehouse/queries.js';
import { newQrToken } from '../warehouse/tokens.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const TYPE_CODE_PATTERN = '^[A-Z][A-Z0-9_]{1,29}$';

interface Destination {
  locationId: string | null;
  parentId: string | null;
  label: string;
}

/**
 * Comprueba que el destino existe y admite contenedores.
 * `moving` es el contenedor que se mueve, si lo hay, para impedir meterlo dentro de sí mismo.
 */
async function resolveDestination(
  c: pg.PoolClient,
  dest: { locationId?: string; parentContainerId?: string },
  options: { moving?: string; adding: number; force: boolean },
): Promise<Destination> {
  if (Boolean(dest.locationId) === Boolean(dest.parentContainerId)) {
    throw badRequest('Indica un destino: una ubicación o un contenedor, no ambos', 'DESTINO_NO_VALIDO');
  }

  if (dest.locationId) {
    const r = await c.query(
      `SELECT l.code, l.active, l.max_capacity::float AS max,
              (SELECT count(*)::int FROM container k
                WHERE k.location_id = l.id AND k.status = 'ACTIVE' AND k.id IS DISTINCT FROM $2::uuid) AS used
         FROM storage_location l WHERE l.id = $1 FOR UPDATE OF l`,
      [dest.locationId, options.moving ?? null],
    );
    const loc = r.rows[0];
    if (!loc) throw badRequest('La ubicación de destino no existe', 'UBICACION_NO_EXISTE');
    if (!loc.active) throw conflict('La ubicación de destino está desactivada', 'UBICACION_INACTIVA');

    if (loc.max !== null && loc.used + options.adding > loc.max) {
      const policy = await getParameter<string>(c, 'capacity.policy', 'WARN');
      if (policy === 'BLOCK' || !options.force) {
        throw new AppError(
          409,
          policy === 'BLOCK' ? 'CAPACIDAD_BLOQUEADA' : 'CAPACIDAD_SUPERADA',
          `La ubicación ${loc.code} admite ${loc.max} contenedores y ya tiene ${loc.used}`,
        );
      }
    }
    return { locationId: dest.locationId, parentId: null, label: loc.code };
  }

  const r = await c.query(`SELECT code, status FROM container WHERE id = $1 FOR UPDATE`, [dest.parentContainerId]);
  const parent = r.rows[0];
  if (!parent) throw badRequest('El contenedor de destino no existe', 'CONTENEDOR_NO_EXISTE');
  if (parent.status !== 'ACTIVE') throw conflict('El contenedor de destino está retirado', 'CONTENEDOR_RETIRADO');

  if (options.moving) {
    if (options.moving === dest.parentContainerId) {
      throw conflict('Un contenedor no puede meterse dentro de sí mismo', 'CONTENEDOR_CICLICO');
    }
    const chain = await containerChain(c, dest.parentContainerId!);
    if (chain.some((k) => k.id === options.moving)) {
      throw conflict('Un contenedor no puede meterse dentro de uno que lleva dentro', 'CONTENEDOR_CICLICO');
    }
  }
  return { locationId: null, parentId: dest.parentContainerId!, label: parent.code };
}

export function containerRoutes(app: FastifyInstance, deps: { pool: pg.Pool }) {
  const { pool } = deps;

  // ---- Tipos de contenedor ------------------------------------------------
  app.get('/api/container-types', { preHandler: requirePermission('container.read') }, async () => {
    const r = await pool.query(
      `SELECT code, name, code_prefix AS "codePrefix", default_reuse_policy AS "defaultReusePolicy", active
         FROM container_type ORDER BY name`,
    );
    return { types: r.rows };
  });

  app.post(
    '/api/container-types',
    {
      preHandler: requirePermission('admin.masterdata.manage'),
      schema: {
        body: {
          type: 'object', required: ['code', 'name', 'codePrefix'], additionalProperties: false,
          properties: {
            code: { type: 'string', pattern: TYPE_CODE_PATTERN },
            name: { type: 'string', minLength: 1, maxLength: 60 },
            codePrefix: { type: 'string', pattern: '^[A-Z]{2,5}$' },
            defaultReusePolicy: { type: 'string', enum: ['REUSABLE', 'DISPOSABLE'] },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { code: string; name: string; codePrefix: string; defaultReusePolicy?: string };
      const dup = await pool.query(`SELECT 1 FROM container_type WHERE code = $1 OR code_prefix = $2`, [
        body.code, body.codePrefix,
      ]);
      if (dup.rowCount) throw conflict('Ya existe un tipo de contenedor con ese código o prefijo', 'TIPO_DUPLICADO');
      await pool.query(
        `INSERT INTO container_type (code, name, code_prefix, default_reuse_policy) VALUES ($1, $2, $3, $4)`,
        [body.code, body.name.trim(), body.codePrefix, body.defaultReusePolicy ?? 'REUSABLE'],
      );
      await writeAudit(pool, {
        userId: request.user!.id, action: 'tipo_contenedor.alta', entityType: 'container_type', entityId: body.code,
        after: body, ip: request.ip, requestId: request.id,
      });
      reply.code(201);
      return {
        type: {
          code: body.code, name: body.name.trim(), codePrefix: body.codePrefix,
          defaultReusePolicy: body.defaultReusePolicy ?? 'REUSABLE', active: true,
        },
      };
    },
  );

  // ---- Consulta -----------------------------------------------------------
  app.get(
    '/api/containers',
    {
      preHandler: requirePermission('container.read'),
      schema: {
        querystring: {
          type: 'object', additionalProperties: false,
          properties: {
            q: { type: 'string', maxLength: 60 },
            includeRetired: { type: 'boolean', default: false },
          },
        },
      },
    },
    async (request) => {
      const q = request.query as { q?: string; includeRetired: boolean };
      const r = await pool.query(
        `${CONTAINER_SELECT}
          WHERE ($1::text IS NULL OR c.code ILIKE '%' || $1 || '%' OR c.description ILIKE '%' || $1 || '%')
            AND (c.status = 'ACTIVE' OR $2)
          ORDER BY c.code LIMIT 100`,
        [q.q?.trim() || null, q.includeRetired],
      );
      return { containers: r.rows };
    },
  );

  app.get('/api/containers/:id', { preHandler: requirePermission('container.read'), schema: { params: idParams } }, async (request) => {
    const detail = await containerDetail(pool, (request.params as { id: string }).id);
    if (!detail) throw notFound('El contenedor no existe');
    return detail;
  });

  // ---- Alta ---------------------------------------------------------------
  app.post(
    '/api/containers',
    {
      preHandler: requirePermission('container.manage'),
      schema: {
        body: {
          type: 'object', required: ['typeCode'], additionalProperties: false,
          properties: {
            typeCode: { type: 'string', maxLength: 30 },
            locationId: uuid,
            parentContainerId: uuid,
            description: { type: 'string', maxLength: 300 },
            reusePolicy: { type: 'string', enum: ['REUSABLE', 'DISPOSABLE'] },
            responsibleUserId: uuid,
            quantity: { type: 'integer', minimum: 1, maximum: 100, default: 1 },
            force: { type: 'boolean', default: false },
          },
        },
      },
    },
    (request, reply) =>
      idempotent(pool, request, reply, async () => {
        const body = request.body as {
          typeCode: string; locationId?: string; parentContainerId?: string; description?: string;
          reusePolicy?: string; responsibleUserId?: string; quantity: number; force: boolean;
        };

        const ids = await withTransaction(pool, async (c) => {
          // Bloquea el tipo para que dos altas simultáneas no repitan código.
          const t = await c.query(
            `SELECT id, code_prefix, next_number, default_reuse_policy FROM container_type
              WHERE code = $1 AND active FOR UPDATE`,
            [body.typeCode],
          );
          const type = t.rows[0];
          if (!type) throw badRequest('El tipo de contenedor no existe', 'TIPO_NO_EXISTE');

          const dest = await resolveDestination(c, body, { adding: body.quantity, force: body.force });
          if (body.responsibleUserId) {
            const u = await c.query(`SELECT 1 FROM app_user WHERE id = $1 AND active`, [body.responsibleUserId]);
            if (!u.rowCount) throw badRequest('El responsable indicado no existe', 'USUARIO_NO_EXISTE');
          }

          const created: string[] = [];
          for (let i = 0; i < body.quantity; i++) {
            const code = `${type.code_prefix}-${String(type.next_number + i).padStart(6, '0')}`;
            const r = await c.query(
              `INSERT INTO container
                 (qr_token, code, container_type_id, location_id, parent_container_id, reuse_policy,
                  responsible_user_id, description)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
              [
                newQrToken(), code, type.id, dest.locationId, dest.parentId,
                body.reusePolicy ?? type.default_reuse_policy, body.responsibleUserId ?? null,
                body.description?.trim() || null,
              ],
            );
            const id = r.rows[0].id as string;
            created.push(id);
            await recordContainerMove(c, {
              userId: request.user!.id, containerId: id, fromLocationId: null, fromParentId: null,
              toLocationId: dest.locationId, toParentId: dest.parentId, reason: 'Alta del contenedor',
            });
            await writeAudit(c, {
              userId: request.user!.id, action: 'contenedor.alta', entityType: 'container', entityId: id,
              after: { code, typeCode: body.typeCode, destino: dest.label }, ip: request.ip, requestId: request.id,
            });
          }
          await c.query(`UPDATE container_type SET next_number = next_number + $2 WHERE id = $1`, [type.id, body.quantity]);
          return created;
        });

        const r = await pool.query(`${CONTAINER_SELECT} WHERE c.id = ANY($1) ORDER BY c.code`, [ids]);
        reply.code(201);
        return { containers: r.rows };
      }),
  );

  // ---- Edición ------------------------------------------------------------
  app.patch(
    '/api/containers/:id',
    {
      preHandler: requirePermission('container.manage'),
      schema: {
        params: idParams,
        body: {
          type: 'object', additionalProperties: false, minProperties: 1,
          properties: {
            description: { type: 'string', maxLength: 300 },
            reusePolicy: { type: 'string', enum: ['REUSABLE', 'DISPOSABLE'] },
            responsibleUserId: { anyOf: [uuid, { type: 'null' }] },
          },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = request.body as { description?: string; reusePolicy?: string; responsibleUserId?: string | null };
      await withTransaction(pool, async (c) => {
        const before = (await c.query(`${CONTAINER_SELECT} WHERE c.id = $1`, [id])).rows[0];
        if (!before) throw notFound('El contenedor no existe');
        if (body.responsibleUserId) {
          const u = await c.query(`SELECT 1 FROM app_user WHERE id = $1 AND active`, [body.responsibleUserId]);
          if (!u.rowCount) throw badRequest('El responsable indicado no existe', 'USUARIO_NO_EXISTE');
        }
        await c.query(
          `UPDATE container
              SET description = CASE WHEN $2::text IS NULL THEN description ELSE nullif($2, '') END,
                  reuse_policy = coalesce($3, reuse_policy),
                  responsible_user_id = CASE WHEN $4 THEN $5::uuid ELSE responsible_user_id END,
                  updated_at = now()
            WHERE id = $1`,
          [id, body.description?.trim() ?? null, body.reusePolicy ?? null, 'responsibleUserId' in body, body.responsibleUserId ?? null],
        );
        const after = (await c.query(`${CONTAINER_SELECT} WHERE c.id = $1`, [id])).rows[0];
        const pick = (k: Record<string, unknown>) => ({
          description: k.description, reusePolicy: k.reusePolicy, responsibleUserId: k.responsibleUserId,
        });
        await writeAudit(c, {
          userId: request.user!.id, action: 'contenedor.modificacion', entityType: 'container', entityId: id,
          before: pick(before), after: pick(after), ip: request.ip, requestId: request.id,
        });
      });
      return containerDetail(pool, id);
    },
  );

  // ---- Mover --------------------------------------------------------------
  // Mueve el contenedor con todo lo que lleva dentro: solo cambia el sitio del
  // contenedor movido y sus descendientes lo heredan.
  app.post(
    '/api/containers/:id/move',
    {
      preHandler: requirePermission('container.move'),
      schema: {
        params: idParams,
        body: {
          type: 'object', additionalProperties: false,
          properties: {
            toLocationId: uuid,
            toParentContainerId: uuid,
            reason: { type: 'string', maxLength: 300 },
            force: { type: 'boolean', default: false },
          },
        },
      },
    },
    (request, reply) =>
      idempotent(pool, request, reply, async () => {
        const { id } = request.params as { id: string };
        const body = request.body as { toLocationId?: string; toParentContainerId?: string; reason?: string; force: boolean };

        const result = await withTransaction(pool, async (c) => {
          const r = await c.query(
            `SELECT code, status, location_id, parent_container_id FROM container WHERE id = $1 FOR UPDATE`,
            [id],
          );
          const current = r.rows[0];
          if (!current) throw notFound('El contenedor no existe');
          if (current.status !== 'ACTIVE') throw conflict('El contenedor está retirado', 'CONTENEDOR_RETIRADO');

          const dest = await resolveDestination(
            c,
            { locationId: body.toLocationId, parentContainerId: body.toParentContainerId },
            { moving: id, adding: 1, force: body.force },
          );
          if (dest.locationId === current.location_id && dest.parentId === current.parent_container_id) {
            throw conflict(`El contenedor ya está en ${dest.label}`, 'MISMO_LUGAR');
          }

          await c.query(
            `UPDATE container SET location_id = $2, parent_container_id = $3, updated_at = now() WHERE id = $1`,
            [id, dest.locationId, dest.parentId],
          );
          const movementNumber = await recordContainerMove(c, {
            userId: request.user!.id, containerId: id,
            fromLocationId: current.location_id, fromParentId: current.parent_container_id,
            toLocationId: dest.locationId, toParentId: dest.parentId, reason: body.reason?.trim() || null,
          });
          const descendants = await descendantCount(c, id);
          await writeAudit(c, {
            userId: request.user!.id, action: 'contenedor.movimiento', entityType: 'container', entityId: id,
            after: { code: current.code, destino: dest.label, movimiento: movementNumber, descendientes: descendants },
            ip: request.ip, requestId: request.id,
          });
          return { movementNumber, descendantsMoved: descendants, destination: dest.label };
        });

        return { ...result, ...(await containerDetail(pool, id)) };
      }),
  );

  // ---- Retirar ------------------------------------------------------------
  app.post(
    '/api/containers/:id/retire',
    {
      preHandler: requirePermission('container.manage'),
      schema: {
        params: idParams,
        body: {
          type: 'object', additionalProperties: false,
          properties: { reason: { type: 'string', maxLength: 300 } },
        },
      },
    },
    (request, reply) =>
      idempotent(pool, request, reply, async () => {
        const { id } = request.params as { id: string };
        const reason = (request.body as { reason?: string } | undefined)?.reason?.trim() || 'Retirada del contenedor';

        await withTransaction(pool, async (c) => {
          const r = await c.query(
            `SELECT code, status, location_id, parent_container_id FROM container WHERE id = $1 FOR UPDATE`,
            [id],
          );
          const current = r.rows[0];
          if (!current) throw notFound('El contenedor no existe');
          if (current.status !== 'ACTIVE') throw conflict('El contenedor ya está retirado', 'CONTENEDOR_RETIRADO');

          const inside = await c.query(
            `SELECT (SELECT count(*)::int FROM container WHERE parent_container_id = $1 AND status = 'ACTIVE') AS children,
                    (SELECT count(*)::int FROM stock_balance WHERE container_id = $1 AND (quantity IS NULL OR quantity > 0)) AS stock`,
            [id],
          );
          if (inside.rows[0].children > 0 || inside.rows[0].stock > 0) {
            throw conflict('Solo se puede retirar un contenedor vacío', 'CONTENEDOR_NO_VACIO');
          }

          await c.query(
            `UPDATE container
                SET status = 'RETIRED', location_id = NULL, parent_container_id = NULL,
                    retired_at = now(), updated_at = now()
              WHERE id = $1`,
            [id],
          );
          await recordContainerMove(c, {
            userId: request.user!.id, containerId: id,
            fromLocationId: current.location_id, fromParentId: current.parent_container_id,
            toLocationId: null, toParentId: null, reason,
          });
          await writeAudit(c, {
            userId: request.user!.id, action: 'contenedor.retirada', entityType: 'container', entityId: id,
            after: { code: current.code }, ip: request.ip, requestId: request.id,
          });
        });
        return containerDetail(pool, id);
      }),
  );

  // ---- Escaneo ------------------------------------------------------------
  // Resuelve lo leído en un QR (o un código tecleado a mano) y dice qué es.
  app.get(
    '/api/scan/:code',
    {
      preHandler: requirePermission('container.read'),
      schema: {
        params: {
          type: 'object', required: ['code'],
          properties: { code: { type: 'string', minLength: 1, maxLength: 60 } },
        },
      },
    },
    async (request) => {
      const raw = (request.params as { code: string }).code.trim();
      const r = await pool.query(
        `SELECT 'container' AS kind, id, code, NULL AS name, (qr_token = $1) AS exact FROM container
          WHERE qr_token = $1 OR upper(code) = upper($1)
         UNION ALL
         SELECT 'location', id, code, name, (qr_token = $1) FROM storage_location
          WHERE qr_token = $1 OR upper(code) = upper($1)
         UNION ALL
         SELECT 'equipment', id, code, description, (qr_token = $1) FROM equipment
          WHERE qr_token = $1 OR upper(code) = upper($1)
         ORDER BY exact DESC LIMIT 1`,
        [raw],
      );
      const hit = r.rows[0];
      if (!hit) throw notFound('Ese código no corresponde a nada registrado en el sistema');
      return { kind: hit.kind, id: hit.id, code: hit.code, name: hit.name };
    },
  );

  // Lista mínima de usuarios, para elegir el responsable de un contenedor.
  app.get('/api/users/basic', { preHandler: requirePermission('container.read') }, async () => {
    const r = await pool.query(`SELECT id, full_name AS "fullName" FROM app_user WHERE active ORDER BY full_name`);
    return { users: r.rows };
  });
}
