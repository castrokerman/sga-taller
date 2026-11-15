import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { writeAudit } from '../audit.js';
import { requireAuth, requirePermission } from '../auth/guard.js';
import { withTransaction } from '../db/tx.js';
import { badRequest, forbidden, notFound } from '../errors.js';
import { idempotent } from '../idempotency.js';

/**
 * Fotos y anotaciones de ubicaciones, contenedores y materiales, y los avisos
 * que generan las anotaciones marcadas para notificar a responsables.
 */

export type EntityType = 'location' | 'container' | 'material' | 'inbound';
const ENTITY_TYPES = ['location', 'container', 'material'] as const;
/** Las fotos también pueden ser de una recepción pendiente de identificar. */
const PHOTO_ENTITY_TYPES = ['location', 'container', 'material', 'inbound'] as const;
const READ_PERMISSION: Record<Exclude<EntityType, 'inbound'>, string> = {
  location: 'location.read',
  container: 'container.read',
  material: 'material.read',
};
const NOT_FOUND: Record<EntityType, string> = {
  location: 'La ubicación no existe',
  container: 'El contenedor no existe',
  material: 'El contenido no existe',
  inbound: 'La recepción no existe',
};

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const entityQuery = {
  type: 'object', required: ['entityType', 'entityId'], additionalProperties: false,
  properties: { entityType: { type: 'string', enum: ENTITY_TYPES }, entityId: uuid },
} as const;
const photoQuery = {
  type: 'object', required: ['entityType', 'entityId'], additionalProperties: false,
  properties: { entityType: { type: 'string', enum: PHOTO_ENTITY_TYPES }, entityId: uuid },
} as const;

/**
 * Una recepción la ven quien la registró, su responsable y quien gestiona
 * las recepciones.
 */
export async function canSeeInbound(db: pg.Pool | pg.PoolClient, request: FastifyRequest, id: string): Promise<boolean> {
  if (request.user!.permissions.includes('inbound.manage')) return true;
  const r = await db.query(
    `SELECT 1 FROM inbound_item i
      WHERE i.id = $1 AND ($2 IN (i.received_by, i.responsible_user_id)
        OR EXISTS (SELECT 1 FROM pre_receipt pr WHERE pr.id = i.pre_receipt_id AND pr.created_by = $2) OR EXISTS (
            SELECT 1 FROM project_member pm WHERE pm.project_id = i.project_id AND pm.user_id = $2 AND pm.role = 'RESPONSIBLE'))`,
    [id, request.user!.id],
  );
  return Boolean(r.rowCount);
}

interface Entity {
  type: EntityType;
  id: string;
  code: string;
  name: string | null;
  responsibleUserId: string | null;
}

/** Comprueba que existe y que el usuario puede verla. */
async function getEntity(db: pg.Pool | pg.PoolClient, request: FastifyRequest, type: EntityType, id: string): Promise<Entity> {
  if (type === 'inbound') {
    const r = await db.query(`SELECT 'REC-' || lpad(number::text, 6, '0') AS code, description FROM inbound_item WHERE id = $1`, [id]);
    if (!r.rows[0]) throw notFound(NOT_FOUND.inbound);
    if (!(await canSeeInbound(db, request, id))) throw forbidden();
    return { type, id, code: r.rows[0].code, name: r.rows[0].description, responsibleUserId: null };
  }
  if (!request.user!.permissions.includes(READ_PERMISSION[type])) throw forbidden();
  const sql = {
    location: `SELECT code, name, NULL::uuid AS responsible FROM storage_location WHERE id = $1`,
    container: `SELECT code, description AS name, responsible_user_id AS responsible FROM container WHERE id = $1`,
    material: `SELECT internal_ref AS code, description AS name, NULL::uuid AS responsible FROM material WHERE id = $1`,
  }[type];
  const r = await db.query(sql, [id]);
  if (!r.rows[0]) throw notFound(NOT_FOUND[type]);
  return { type, id, code: r.rows[0].code, name: r.rows[0].name, responsibleUserId: r.rows[0].responsible };
}

/** Destinatarios propuestos: los responsables de almacén y, en un contenedor, su responsable. */
async function suggestedRecipients(db: pg.Pool | pg.PoolClient, e: Entity): Promise<string[]> {
  const r = await db.query(
    `SELECT DISTINCT u.id FROM app_user u
       JOIN user_role ur ON ur.user_id = u.id JOIN role ro ON ro.id = ur.role_id
      WHERE u.active AND ro.code = 'RESP_ALMACEN'`,
  );
  const ids = r.rows.map((x) => x.id as string);
  if (e.responsibleUserId && !ids.includes(e.responsibleUserId)) ids.push(e.responsibleUserId);
  return ids;
}

/** Comprueba que lo recibido es de verdad una imagen JPEG, PNG o WebP. */
export function imageType(buf: Buffer): string | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length > 12 && buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return null;
}

const PHOTO_SELECT = `
  SELECT p.id, p.position, p.width, p.height, p.caption, p.mime_type AS "mimeType",
         octet_length(p.image) AS bytes, p.uploaded_at AS "uploadedAt",
         p.uploaded_by AS "uploadedById", u.full_name AS "uploadedBy", p.purpose
    FROM photo p JOIN app_user u ON u.id = p.uploaded_by`;

const NOTE_SELECT = `
  SELECT n.id, n.body, n.notify, n.created_at AS "createdAt", n.created_by AS "createdById", u.full_name AS "createdBy",
         n.parent_id AS "parentId",
         coalesce((SELECT json_agg(r.full_name ORDER BY r.full_name)
                     FROM notification nf JOIN app_user r ON r.id = nf.user_id WHERE nf.note_id = n.id), '[]') AS recipients
    FROM note n JOIN app_user u ON u.id = n.created_by`;

/** Código y nombre de lo anotado, para mostrar en los avisos. */
const ENTITY_LABEL = `
  CASE n.entity_type
    WHEN 'location'  THEN (SELECT code FROM storage_location WHERE id = n.entity_id)
    WHEN 'container' THEN (SELECT code FROM container WHERE id = n.entity_id)
    WHEN 'material'  THEN (SELECT internal_ref FROM material WHERE id = n.entity_id)
  END`;
const ENTITY_NAME = `
  CASE n.entity_type
    WHEN 'location'  THEN (SELECT name FROM storage_location WHERE id = n.entity_id)
    WHEN 'container' THEN (SELECT description FROM container WHERE id = n.entity_id)
    WHEN 'material'  THEN (SELECT description FROM material WHERE id = n.entity_id)
  END`;

export function extrasRoutes(app: FastifyInstance, deps: { pool: pg.Pool }) {
  const { pool } = deps;

  // ---- Fotos --------------------------------------------------------------
  app.get('/api/photos', { preHandler: requireAuth(), schema: { querystring: photoQuery } }, async (request) => {
    const q = request.query as { entityType: EntityType; entityId: string };
    await getEntity(pool, request, q.entityType, q.entityId);
    const r = await pool.query(`${PHOTO_SELECT} WHERE p.entity_type = $1 AND p.entity_id = $2 ORDER BY p.purpose DESC, p.position, p.uploaded_at`, [q.entityType, q.entityId]);
    return { photos: r.rows };
  });

  // La web reduce la foto antes de enviarla (lado largo de 1600 px y miniatura de 400 px).
  app.post(
    '/api/photos',
    {
      preHandler: requirePermission('photo.add'),
      bodyLimit: 12 * 1024 * 1024,
      schema: {
        body: {
          type: 'object', required: ['entityType', 'entityId', 'image', 'thumbnail', 'width', 'height'], additionalProperties: false,
          properties: {
            entityType: { type: 'string', enum: PHOTO_ENTITY_TYPES },
            entityId: uuid,
            image: { type: 'string', maxLength: 7_500_000 },
            thumbnail: { type: 'string', maxLength: 700_000 },
            width: { type: 'integer', minimum: 1, maximum: 10000 },
            height: { type: 'integer', minimum: 1, maximum: 10000 },
            caption: { type: 'string', maxLength: 200 },
            purpose: { type: 'string', enum: ['GENERAL', 'CONTENTS'] },
          },
        },
      },
    },
    (request, reply) =>
      idempotent(pool, request, reply, async () => {
        const b = request.body as {
          entityType: EntityType; entityId: string; image: string; thumbnail: string; width: number; height: number; caption?: string;
          purpose?: 'GENERAL' | 'CONTENTS';
        };
        const purpose = b.purpose ?? 'GENERAL';
        if (purpose === 'CONTENTS' && b.entityType !== 'container') throw badRequest('Solo los contenedores tienen foto del contenido', 'FOTO_CONTENIDO');
        const image = Buffer.from(b.image, 'base64');
        const thumb = Buffer.from(b.thumbnail, 'base64');
        const mime = imageType(image);
        if (!mime || !imageType(thumb)) throw badRequest('El archivo no es una imagen JPEG, PNG o WebP', 'IMAGEN_NO_VALIDA');
        if (image.length > 5 * 1024 * 1024) throw badRequest('La foto es demasiado grande (máximo 5 MB)', 'IMAGEN_GRANDE');
        const id = await withTransaction(pool, async (c) => {
          const e = await getEntity(c, request, b.entityType, b.entityId);
          const pos = await c.query(
            `SELECT coalesce(max(position) + 1, 0) AS n FROM photo WHERE entity_type = $1 AND entity_id = $2 AND purpose = $3`,
            [b.entityType, b.entityId, purpose],
          );
          const r = await c.query(
            `INSERT INTO photo (entity_type, entity_id, position, mime_type, width, height, image, thumbnail, caption, uploaded_by, purpose)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
            [b.entityType, b.entityId, pos.rows[0].n, mime, b.width, b.height, image, thumb, b.caption?.trim() || null, request.user!.id, purpose],
          );
          await writeAudit(c, {
            userId: request.user!.id, action: purpose === 'CONTENTS' ? 'foto.contenido' : 'foto.alta', entityType: b.entityType, entityId: b.entityId,
            after: { foto: r.rows[0].id, de: e.code, bytes: image.length }, ip: request.ip, requestId: request.id,
          });
          return r.rows[0].id as string;
        });
        reply.code(201);
        return { photo: (await pool.query(`${PHOTO_SELECT} WHERE p.id = $1`, [id])).rows[0] };
      }),
  );

  for (const [path, column] of [['image', 'image'], ['thumb', 'thumbnail']] as const) {
    app.get(`/api/photos/:id/${path}`, { preHandler: requireAuth(), schema: { params: idParams } }, async (request, reply) => {
      const r = await pool.query(`SELECT entity_type, entity_id, mime_type, ${column} AS data FROM photo WHERE id = $1`, [
        (request.params as { id: string }).id,
      ]);
      const p = r.rows[0];
      if (!p) throw notFound('La foto no existe');
      const allowed = p.entity_type === 'inbound'
        ? await canSeeInbound(pool, request, p.entity_id)
        : request.user!.permissions.includes(READ_PERMISSION[p.entity_type as Exclude<EntityType, 'inbound'>]);
      if (!allowed) throw forbidden();
      // El contenido de una foto no cambia nunca: el navegador puede guardarla.
      return reply
        .header('content-type', p.mime_type)
        .header('cache-control', 'private, max-age=604800, immutable')
        .header('x-content-type-options', 'nosniff')
        .send(p.data);
    });
  }

  // Pasa a ser la principal (la primera).
  app.post('/api/photos/:id/primary', { preHandler: requirePermission('photo.add'), schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    await withTransaction(pool, async (c) => {
      const p = (await c.query(`SELECT entity_type, entity_id, purpose FROM photo WHERE id = $1`, [id])).rows[0];
      if (!p) throw notFound('La foto no existe');
      if (p.purpose !== 'GENERAL') throw badRequest('Las fotos del contenido no son principales: vale la más reciente', 'FOTO_CONTENIDO');
      await getEntity(c, request, p.entity_type, p.entity_id);
      const all = await c.query(`SELECT id FROM photo WHERE entity_type = $1 AND entity_id = $2 AND purpose = 'GENERAL' ORDER BY position, uploaded_at FOR UPDATE`, [
        p.entity_type, p.entity_id,
      ]);
      const order = [id, ...all.rows.map((x) => x.id as string).filter((x) => x !== id)];
      for (const [i, pid] of order.entries()) await c.query(`UPDATE photo SET position = $2 WHERE id = $1`, [pid, i]);
    });
    return { ok: true };
  });

  app.delete('/api/photos/:id', { preHandler: requirePermission('photo.add'), schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    await withTransaction(pool, async (c) => {
      const p = (await c.query(`SELECT entity_type, entity_id, uploaded_by FROM photo WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!p) throw notFound('La foto no existe');
      const e = await getEntity(c, request, p.entity_type, p.entity_id);
      if (p.uploaded_by !== request.user!.id && !request.user!.permissions.includes('photo.manage')) {
        throw forbidden('Solo quien subió la foto o un responsable puede quitarla');
      }
      await c.query(`DELETE FROM photo WHERE id = $1`, [id]);
      const rest = await c.query(`SELECT id FROM photo WHERE entity_type = $1 AND entity_id = $2 ORDER BY position, uploaded_at`, [
        p.entity_type, p.entity_id,
      ]);
      for (const [i, row] of rest.rows.entries()) await c.query(`UPDATE photo SET position = $2 WHERE id = $1`, [row.id, i]);
      await writeAudit(c, {
        userId: request.user!.id, action: 'foto.baja', entityType: p.entity_type, entityId: p.entity_id,
        before: { foto: id, de: e.code }, ip: request.ip, requestId: request.id,
      });
    });
    return { ok: true };
  });

  // ---- Anotaciones --------------------------------------------------------
  app.get('/api/notes', { preHandler: requireAuth(), schema: { querystring: entityQuery } }, async (request) => {
    const q = request.query as { entityType: EntityType; entityId: string };
    await getEntity(pool, request, q.entityType, q.entityId);
    const r = await pool.query(`${NOTE_SELECT} WHERE n.entity_type = $1 AND n.entity_id = $2 ORDER BY n.created_at DESC`, [
      q.entityType, q.entityId,
    ]);
    return { notes: r.rows };
  });

  // A quién se propone avisar, y la lista de personas para añadir o quitar.
  app.get('/api/notes/recipients', { preHandler: requirePermission('note.add'), schema: { querystring: entityQuery } }, async (request) => {
    const q = request.query as { entityType: EntityType; entityId: string };
    const e = await getEntity(pool, request, q.entityType, q.entityId);
    const suggested = (await suggestedRecipients(pool, e)).filter((id) => id !== request.user!.id);
    const users = await pool.query(
      `SELECT u.id, u.full_name AS "fullName",
              coalesce(array_agg(ro.name ORDER BY ro.name) FILTER (WHERE ro.id IS NOT NULL), '{}') AS roles
         FROM app_user u LEFT JOIN user_role ur ON ur.user_id = u.id LEFT JOIN role ro ON ro.id = ur.role_id
        WHERE u.active AND u.id <> $1
        GROUP BY u.id ORDER BY u.full_name`,
      [request.user!.id],
    );
    return { suggested, users: users.rows };
  });

  app.post(
    '/api/notes',
    {
      preHandler: requirePermission('note.add'),
      schema: {
        body: {
          type: 'object', required: ['entityType', 'entityId', 'body'], additionalProperties: false,
          properties: {
            entityType: { type: 'string', enum: ENTITY_TYPES },
            entityId: uuid,
            body: { type: 'string', minLength: 1, maxLength: 4000 },
            notify: { type: 'boolean', default: false },
            recipientIds: { type: 'array', maxItems: 200, items: uuid },
            parentId: uuid,
          },
        },
      },
    },
    (request, reply) =>
      idempotent(pool, request, reply, async () => {
        const b = request.body as {
          entityType: EntityType; entityId: string; body: string; notify: boolean; recipientIds?: string[]; parentId?: string;
        };
        const text = b.body.trim();
        if (!text) throw badRequest('Escribe el comentario');
        const out = await withTransaction(pool, async (c) => {
          const e = await getEntity(c, request, b.entityType, b.entityId);
          // Una respuesta cuelga del comentario original (si se responde a una respuesta, también).
          let rootId: string | null = null;
          if (b.parentId) {
            const p = (await c.query(`SELECT id, parent_id, entity_type, entity_id FROM note WHERE id = $1`, [b.parentId])).rows[0];
            if (!p || p.entity_type !== b.entityType || p.entity_id !== b.entityId) throw badRequest('El comentario al que respondes no existe', 'COMENTARIO_NO_EXISTE');
            rootId = (p.parent_id as string | null) ?? (p.id as string);
          }
          const n = await c.query(
            `INSERT INTO note (entity_type, entity_id, body, notify, created_by, parent_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
            [b.entityType, b.entityId, text, b.notify || Boolean(rootId), request.user!.id, rootId],
          );
          const noteId = n.rows[0].id as string;
          const recipients = new Set<string>();
          if (rootId) {
            // Al responder se avisa a quien escribió el comentario y a quienes ya respondieron.
            const thread = await c.query(`SELECT DISTINCT created_by FROM note WHERE id = $1 OR parent_id = $1`, [rootId]);
            for (const r of thread.rows) recipients.add(r.created_by);
          }
          if (b.notify) {
            const wanted = b.recipientIds ?? (await suggestedRecipients(c, e));
            for (const id of wanted) recipients.add(id);
          }
          recipients.delete(request.user!.id);
          const valid = await c.query(`SELECT id FROM app_user WHERE id = ANY($1) AND active`, [[...recipients]]);
          if (b.notify && !rootId && !valid.rowCount) throw badRequest('Elige al menos a una persona a la que avisar', 'SIN_DESTINATARIOS');
          for (const u of valid.rows) {
            await c.query(`INSERT INTO notification (user_id, note_id) VALUES ($1, $2)`, [u.id, noteId]);
          }
          const notified = valid.rowCount ?? 0;
          await writeAudit(c, {
            userId: request.user!.id, action: rootId ? 'comentario.respuesta' : 'comentario.alta', entityType: b.entityType, entityId: b.entityId,
            after: { comentario: noteId, responde_a: rootId, de: e.code, avisados: notified }, ip: request.ip, requestId: request.id,
          });
          return { noteId, notified };
        });
        reply.code(201);
        return { note: (await pool.query(`${NOTE_SELECT} WHERE n.id = $1`, [out.noteId])).rows[0], notified: out.notified };
      }),
  );

  // ---- Avisos -------------------------------------------------------------
  app.get(
    '/api/notifications',
    {
      preHandler: requireAuth(),
      schema: { querystring: { type: 'object', additionalProperties: false, properties: { all: { type: 'boolean', default: false } } } },
    },
    async (request) => {
      const { all } = request.query as { all: boolean };
      const r = await pool.query(
        `SELECT nf.id, nf.created_at AS "createdAt", nf.read_at AS "readAt",
                CASE WHEN nf.inbound_id IS NULL THEN 'note' ELSE 'inbound' END AS kind,
                n.id AS "noteId", coalesce(n.body, nf.message) AS body, (n.parent_id IS NOT NULL) AS "isReply",
                coalesce(n.entity_type, 'inbound') AS "entityType", coalesce(n.entity_id, nf.inbound_id) AS "entityId",
                u.full_name AS "createdBy",
                CASE WHEN nf.inbound_id IS NULL THEN ${ENTITY_LABEL} ELSE 'REC-' || lpad(i.number::text, 6, '0') END AS "entityCode",
                CASE WHEN nf.inbound_id IS NULL THEN ${ENTITY_NAME} ELSE i.description END AS "entityName",
                i.status AS "inboundStatus",
                (i.status = 'PENDING' AND (i.responsible_user_id = nf.user_id OR EXISTS (
                   SELECT 1 FROM project_member pm WHERE pm.project_id = i.project_id AND pm.user_id = nf.user_id AND pm.role = 'RESPONSIBLE'))) AS "actionNeeded"
           FROM notification nf
           LEFT JOIN note n ON n.id = nf.note_id
           LEFT JOIN inbound_item i ON i.id = nf.inbound_id
           JOIN app_user u ON u.id = coalesce(n.created_by, nf.created_by)
          WHERE nf.user_id = $1 AND ($2 OR nf.read_at IS NULL)
          ORDER BY (nf.read_at IS NULL) DESC, nf.created_at DESC
          LIMIT 300`,
        [request.user!.id, all],
      );
      return { notifications: r.rows };
    },
  );

  app.get('/api/notifications/count', { preHandler: requireAuth() }, async (request) => {
    const r = await pool.query(`SELECT count(*)::int AS n FROM notification WHERE user_id = $1 AND read_at IS NULL`, [request.user!.id]);
    return { unread: r.rows[0].n };
  });

  app.post('/api/notifications/:id/read', { preHandler: requireAuth(), schema: { params: idParams } }, async (request) => {
    const r = await pool.query(`UPDATE notification SET read_at = coalesce(read_at, now()) WHERE id = $1 AND user_id = $2`, [
      (request.params as { id: string }).id, request.user!.id,
    ]);
    if (!r.rowCount) throw notFound('El aviso no existe');
    return { ok: true };
  });

  app.post('/api/notifications/read-all', { preHandler: requireAuth() }, async (request) => {
    const r = await pool.query(`UPDATE notification SET read_at = now() WHERE user_id = $1 AND read_at IS NULL`, [request.user!.id]);
    return { marked: r.rowCount };
  });
}
