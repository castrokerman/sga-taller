import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { writeAudit } from '../audit.js';
import { requireAuth, requirePermission } from '../auth/guard.js';
import { withTransaction } from '../db/tx.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { idempotent } from '../idempotency.js';
import {
  applyLine, checkQuantity, createMovement, findOrCreateLot, getMaterial, resolvePlace, unitTargets, type MaterialInfo, type Place,
} from '../inventory/stock.js';
import { canSeeInbound, imageType } from './extras.js';
import { AUTO_REF, contentType } from './materials.js';

/**
 * Recepciones pendientes de identificar.
 *
 * Quien recibe algo que no sabe qué es hace una foto, indica el responsable y
 * lo deja en un sitio provisional. El responsable recibe un aviso y completa
 * el registro: qué es, cuánto, proyecto, dónde se va a usar y si se guarda o
 * se despliega directamente. Al completarlo se hacen los movimientos de stock.
 */

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const text = (max: number) => ({ type: 'string', maxLength: max }) as const;
const photoBody = {
  type: 'object', required: ['image', 'thumbnail', 'width', 'height'], additionalProperties: false,
  properties: {
    image: { type: 'string', maxLength: 7_500_000 },
    thumbnail: { type: 'string', maxLength: 700_000 },
    width: { type: 'integer', minimum: 1, maximum: 10000 },
    height: { type: 'integer', minimum: 1, maximum: 10000 },
  },
} as const;

const CODE = `'REC-' || lpad(i.number::text, 6, '0')`;
const PLACE_CODE = (c: string, l: string) =>
  `coalesce((SELECT code FROM container WHERE id = ${c}), (SELECT code FROM storage_location WHERE id = ${l}))`;

const INBOUND_SELECT = `
  SELECT i.id, i.number, ${CODE} AS code, i.status, i.description, i.packages, i.external_reference AS "externalReference",
         i.received_at AS "receivedAt", i.received_by AS "receivedById", rb.full_name AS "receivedBy",
         i.responsible_user_id AS "responsibleId", rs.full_name AS "responsible",
         i.container_id AS "containerId", i.location_id AS "locationId",
         ${PLACE_CODE('i.container_id', 'i.location_id')} AS "placeCode",
         (SELECT p.id FROM photo p WHERE p.entity_type = 'inbound' AND p.entity_id = i.id ORDER BY p.position, p.uploaded_at LIMIT 1) AS "photoId",
         (SELECT count(*)::int FROM photo p WHERE p.entity_type = 'inbound' AND p.entity_id = i.id) AS "photoCount",
         i.material_id AS "materialId", m.internal_ref AS "materialRef", m.description AS "materialDescription",
         m.unit_code AS "unitCode", i.quantity::float AS quantity, i.lot_code AS "lotCode",
         coalesce(pj.code || ' · ' || pj.name, i.project_ref) AS "projectRef", i.project_id AS "projectId",
         i.usage_place AS "usagePlace", i.disposition,
         i.final_container_id AS "finalContainerId", i.final_location_id AS "finalLocationId",
         ${PLACE_CODE('i.final_container_id', 'i.final_location_id')} AS "finalPlaceCode",
         i.completion_note AS "completionNote", i.completed_at AS "completedAt", cb.full_name AS "completedBy",
         i.cancel_reason AS "cancelReason", i.cancelled_at AS "cancelledAt", xb.full_name AS "cancelledBy"
    FROM inbound_item i
    JOIN app_user rb ON rb.id = i.received_by
    JOIN app_user rs ON rs.id = i.responsible_user_id
    LEFT JOIN app_user cb ON cb.id = i.completed_by
    LEFT JOIN app_user xb ON xb.id = i.cancelled_by
    LEFT JOIN material m ON m.id = i.material_id
    LEFT JOIN project pj ON pj.id = i.project_id`;

interface InboundRow {
  id: string;
  code: string;
  status: 'PENDING' | 'DONE' | 'CANCELLED';
  description: string | null;
  receivedById: string;
  responsibleId: string;
  projectId: string | null;
  containerId: string | null;
  locationId: string | null;
  placeCode: string;
}

const fmt = (n: number | null, unit: string) =>
  n === null ? '' : `${n.toLocaleString('es-ES', { maximumFractionDigits: 4 })} ${unit}`;

async function notify(c: pg.PoolClient, userId: string, inboundId: string, message: string, from: string) {
  await c.query(`INSERT INTO notification (user_id, inbound_id, message, created_by) VALUES ($1, $2, $3, $4)`, [
    userId, inboundId, message, from,
  ]);
}

async function activeUser(c: pg.PoolClient, id: string): Promise<string> {
  const r = await c.query(`SELECT full_name FROM app_user WHERE id = $1 AND active`, [id]);
  if (!r.rows[0]) throw badRequest('El responsable no existe o está dado de baja', 'RESPONSABLE_NO_VALIDO');
  return r.rows[0].full_name;
}

/** Lee la recepción bloqueándola y comprueba que sigue pendiente. */
async function lockPending(c: pg.PoolClient, id: string): Promise<InboundRow> {
  await c.query(`SELECT 1 FROM inbound_item WHERE id = $1 FOR UPDATE`, [id]);
  const r = await c.query(`${INBOUND_SELECT} WHERE i.id = $1`, [id]);
  const row = r.rows[0] as InboundRow | undefined;
  if (!row) throw notFound('La recepción no existe');
  if (row.status !== 'PENDING') {
    throw conflict(row.status === 'DONE' ? 'Esta recepción ya está identificada' : 'Esta recepción está anulada', 'RECEPCION_CERRADA');
  }
  return row;
}

const isManager = (request: FastifyRequest) => request.user!.permissions.includes('inbound.manage');

async function isProjectResponsible(c: pg.Pool | pg.PoolClient, projectId: string | null, userId: string): Promise<boolean> {
  if (!projectId) return false;
  const r = await c.query(`SELECT 1 FROM project_member WHERE project_id = $1 AND user_id = $2 AND role = 'RESPONSIBLE'`, [projectId, userId]);
  return Boolean(r.rowCount);
}

async function insertPhotos(
  c: pg.PoolClient, inboundId: string, userId: string,
  photos: Array<{ image: string; thumbnail: string; width: number; height: number }>,
) {
  for (const [i, p] of photos.entries()) {
    const image = Buffer.from(p.image, 'base64');
    const thumb = Buffer.from(p.thumbnail, 'base64');
    const mime = imageType(image);
    if (!mime || !imageType(thumb)) throw badRequest('Una de las fotos no es una imagen JPEG, PNG o WebP', 'IMAGEN_NO_VALIDA');
    if (image.length > 5 * 1024 * 1024) throw badRequest('Una de las fotos es demasiado grande (máximo 5 MB)', 'IMAGEN_GRANDE');
    await c.query(
      `INSERT INTO photo (entity_type, entity_id, position, mime_type, width, height, image, thumbnail, uploaded_by)
       VALUES ('inbound', $1, $2, $3, $4, $5, $6, $7, $8)`,
      [inboundId, i, mime, p.width, p.height, image, thumb, userId],
    );
  }
}

interface NewMaterial {
  contentTypeCode?: string;
  description: string;
  familyId: string;
  unitCode: string;
  manufacturer?: string;
  manufacturerRef?: string;
}

/** Alta de material desde la recepción: la hace el responsable, que es quien sabe qué es. */
async function createMaterial(c: pg.PoolClient, request: FastifyRequest, nm: NewMaterial): Promise<string> {
  const description = nm.description.trim();
  if (!description) throw badRequest('Escribe qué es el contenido', 'FALTA_DESCRIPCION');
  const fam = await c.query(`SELECT 1 FROM material_family WHERE id = $1`, [nm.familyId]);
  if (!fam.rowCount) throw badRequest('La familia no existe', 'FAMILIA_NO_EXISTE');
  const unit = await c.query(`SELECT 1 FROM unit_of_measure WHERE code = $1`, [nm.unitCode]);
  if (!unit.rowCount) throw badRequest('La unidad no existe', 'UNIDAD_NO_EXISTE');
  const type = (await contentType(c, nm.contentTypeCode)) as { code: string; prefix: string };
  const defaults = (await c.query(`SELECT default_tracking, default_loanable FROM content_type WHERE code = $1`, [type.code])).rows[0];
  const r = await c.query(
    `INSERT INTO material (internal_ref, description, family_id, manufacturer, manufacturer_ref, unit_code,
                           content_type_code, quantity_tracking, is_loanable)
     VALUES (${AUTO_REF('$6::text')}, $1, $2, $3, $4, $5, $7, $8, $9)
     RETURNING id, internal_ref`,
    [description, nm.familyId, nm.manufacturer?.trim() || null, nm.manufacturerRef?.trim() || null, nm.unitCode,
      type.prefix, type.code, defaults.default_tracking, defaults.default_loanable],
  );
  await writeAudit(c, {
    userId: request.user!.id, action: 'material.alta', entityType: 'material', entityId: r.rows[0].id,
    after: { ref: r.rows[0].internal_ref, ...nm, desde: 'recepción' }, ip: request.ip, requestId: request.id,
  });
  return r.rows[0].id as string;
}

export function inboundRoutes(app: FastifyInstance, deps: { pool: pg.Pool }) {
  const { pool } = deps;
  const audit = (c: pg.PoolClient, request: FastifyRequest, action: string, id: string, after: unknown) =>
    writeAudit(c, { userId: request.user!.id, action, entityType: 'inbound_item', entityId: id, after, ip: request.ip, requestId: request.id });

  // ---- Consulta -----------------------------------------------------------
  app.get(
    '/api/inbound',
    {
      preHandler: requireAuth(),
      schema: {
        querystring: {
          type: 'object', additionalProperties: false,
          properties: {
            status: { type: 'string', enum: ['PENDING', 'DONE', 'CANCELLED', 'ALL'], default: 'PENDING' },
            scope: { type: 'string', enum: ['mine', 'all'], default: 'mine' },
          },
        },
      },
    },
    async (request) => {
      const q = request.query as { status: string; scope: 'mine' | 'all' };
      const all = q.scope === 'all' && isManager(request);
      const r = await pool.query(
        `${INBOUND_SELECT}
          WHERE ($1 = 'ALL' OR i.status = $1)
            AND ($2 OR $3 IN (i.responsible_user_id, i.received_by) OR EXISTS (SELECT 1 FROM project_member pm WHERE pm.project_id = i.project_id AND pm.user_id = $3 AND pm.role = 'RESPONSIBLE'))
          ORDER BY i.received_at DESC LIMIT 500`,
        [q.status, all, request.user!.id],
      );
      return { items: r.rows };
    },
  );

  // Cuántas hay pendientes: las mías (para identificar) y todas (para quien gestiona).
  app.get('/api/inbound/count', { preHandler: requireAuth() }, async (request) => {
    const r = await pool.query(
      `SELECT count(*) FILTER (WHERE i.responsible_user_id = $1 OR EXISTS (
                SELECT 1 FROM project_member pm WHERE pm.project_id = i.project_id AND pm.user_id = $1 AND pm.role = 'RESPONSIBLE'))::int AS mine,
              count(*) FILTER (WHERE i.received_by = $1)::int AS received,
              count(*)::int AS total
         FROM inbound_item i WHERE i.status = 'PENDING'`,
      [request.user!.id],
    );
    const row = r.rows[0];
    return { mine: row.mine, received: row.received, total: isManager(request) ? row.total : null };
  });

  // Proyectos ya usados, para proponerlos al escribir.
  app.get('/api/inbound/projects', { preHandler: requireAuth() }, async () => {
    const r = await pool.query(
      `SELECT x FROM (
         SELECT project_ref AS x, max(completed_at) AS t FROM inbound_item WHERE project_ref IS NOT NULL GROUP BY project_ref
         UNION ALL SELECT code || ' · ' || name, now() - interval '100 years' FROM project WHERE false
       ) s GROUP BY x ORDER BY max(t) DESC NULLS LAST LIMIT 200`,
    );
    return { projects: r.rows.map((x) => x.x as string) };
  });

  app.get('/api/inbound/:id', { preHandler: requireAuth(), schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const r = await pool.query(`${INBOUND_SELECT} WHERE i.id = $1`, [id]);
    if (!r.rows[0]) throw notFound('La recepción no existe');
    if (!(await canSeeInbound(pool, request, id))) throw forbidden();
    const item = r.rows[0];
    return {
      item,
      canComplete: item.status === 'PENDING' && (item.responsibleId === request.user!.id || isManager(request)
        || (await isProjectResponsible(pool, item.projectId, request.user!.id))),
      canCancel: item.status === 'PENDING' && (item.receivedById === request.user!.id || isManager(request)),
    };
  });

  // ---- Registrar ----------------------------------------------------------
  app.post(
    '/api/inbound',
    {
      preHandler: requirePermission('stock.receive'),
      bodyLimit: 40 * 1024 * 1024,
      schema: {
        body: {
          type: 'object', required: ['photos'], additionalProperties: false,
          properties: {
            responsibleUserId: uuid, projectId: uuid, containerId: uuid, locationId: uuid,
            description: text(500), packages: { type: 'integer', minimum: 1, maximum: 9999 },
            externalReference: text(80),
            photos: { type: 'array', minItems: 1, maxItems: 4, items: photoBody },
          },
        },
      },
    },
    (request, reply) =>
      idempotent(pool, request, reply, async () => {
        const b = request.body as {
          responsibleUserId?: string; projectId?: string; containerId?: string; locationId?: string; description?: string; packages?: number;
          externalReference?: string; photos: Array<{ image: string; thumbnail: string; width: number; height: number }>;
        };
        if (!b.responsibleUserId && !b.projectId) throw badRequest('Indica de quién es: una persona o un proyecto', 'FALTA_RESPONSABLE');
        const out = await withTransaction(pool, async (c) => {
          // Si va a un proyecto, avisa a todos sus responsables; el primero queda como responsable de la recepción.
          let project: { id: string; label: string; responsibles: string[] } | null = null;
          if (b.projectId) {
            const pr = await c.query(
              `SELECT p.code || ' · ' || p.name AS label,
                      array_agg(pm.user_id ORDER BY pm.position, pm.created_at) FILTER (WHERE pm.role = 'RESPONSIBLE' AND u.active) AS responsibles
                 FROM project p LEFT JOIN project_member pm ON pm.project_id = p.id LEFT JOIN app_user u ON u.id = pm.user_id
                WHERE p.id = $1 AND p.status <> 'CLOSED' GROUP BY p.id`,
              [b.projectId],
            );
            if (!pr.rows[0]) throw badRequest('El proyecto no existe o está cerrado', 'PROYECTO_NO_VALIDO');
            if (!pr.rows[0].responsibles?.length) throw badRequest('Ese proyecto no tiene responsables activos', 'PROYECTO_SIN_RESPONSABLE');
            project = { id: b.projectId, label: pr.rows[0].label, responsibles: pr.rows[0].responsibles };
          }
          const responsibleId: string = b.responsibleUserId ?? project!.responsibles[0]!;
          const responsible = await activeUser(c, responsibleId);
          const place = await resolvePlace(c, b);
          const r = await c.query(
            `INSERT INTO inbound_item (description, packages, external_reference, received_by, responsible_user_id, container_id, location_id, project_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, 'REC-' || lpad(number::text, 6, '0') AS code`,
            [b.description?.trim() || null, b.packages ?? null, b.externalReference?.trim() || null, request.user!.id,
              responsibleId, place.containerId, place.locationId, project?.id ?? null],
          );
          const { id, code } = r.rows[0] as { id: string; code: string };
          await insertPhotos(c, id, request.user!.id, b.photos);
          const toNotify = [...new Set([responsibleId, ...(project?.responsibles ?? [])])].filter((u) => u !== request.user!.id);
          for (const u of toNotify) {
            await notify(
              c, u, id,
              project
                ? `Ha llegado algo para el proyecto ${project.label} y está en ${place.code}. Indica qué es y qué se hace con ello.`
                : `Ha llegado algo a tu nombre y está en ${place.code}. Indica qué es y qué se hace con ello.`,
              request.user!.id,
            );
          }
          const notified = toNotify.length > 0;
          await audit(c, request, 'recepcion.alta', id, {
            recepcion: code, responsable: responsible, proyecto: project?.label ?? null, sitio: place.code, descripcion: b.description ?? null,
            bultos: b.packages ?? null, albaran: b.externalReference ?? null, fotos: b.photos.length,
          });
          return { id, code, responsible: project ? `los responsables de ${project.label}` : responsible, notified, placeCode: place.code };
        });
        reply.code(201);
        return out;
      }),
  );

  // ---- Completar (el responsable) -----------------------------------------
  app.post(
    '/api/inbound/:id/complete',
    {
      preHandler: requireAuth(),
      schema: {
        params: idParams,
        body: {
          type: 'object', required: ['disposition'], additionalProperties: false,
          properties: {
            materialId: uuid,
            newMaterial: {
              type: 'object', required: ['description', 'familyId', 'unitCode'], additionalProperties: false,
              properties: {
                contentTypeCode: text(30),
                description: { type: 'string', minLength: 1, maxLength: 300 }, familyId: uuid,
                unitCode: text(20), manufacturer: text(120), manufacturerRef: text(120),
              },
            },
            quantity: { type: 'number', exclusiveMinimum: 0, maximum: 1e12 },
            lotCode: text(60),
            projectRef: text(150),
            projectId: { anyOf: [{ type: 'null' }, uuid] },
            usagePlace: text(300),
            disposition: { type: 'string', enum: ['STORE', 'DEPLOY'] },
            containerId: uuid, locationId: uuid,
            usePhotoForMaterial: { type: 'boolean', default: false },
            note: text(1000),
          },
        },
      },
    },
    (request, reply) =>
      idempotent(pool, request, reply, async () => {
        const { id } = request.params as { id: string };
        const b = request.body as {
          materialId?: string; newMaterial?: NewMaterial; quantity?: number; lotCode?: string; projectRef?: string; projectId?: string | null;
          usagePlace?: string; disposition: 'STORE' | 'DEPLOY'; containerId?: string; locationId?: string;
          usePhotoForMaterial: boolean; note?: string;
        };
        if (Boolean(b.materialId) === Boolean(b.newMaterial)) {
          throw badRequest('Indica qué es: un contenido del catálogo o uno nuevo', 'FALTA_MATERIAL');
        }
        return withTransaction(pool, async (c) => {
          const item = await lockPending(c, id);
          if (item.responsibleId !== request.user!.id && !isManager(request) && !(await isProjectResponsible(c, item.projectId, request.user!.id))) {
            throw forbidden('Solo el responsable asignado o un responsable de almacén puede completarla');
          }
          const materialId = b.materialId ?? (await createMaterial(c, request, b.newMaterial!));
          const m: MaterialInfo = await getMaterial(c, materialId);
          if (m.status !== 'ACTIVE') throw conflict('El contenido está dado de baja', 'MATERIAL_OBSOLETO');
          if (b.usePhotoForMaterial) {
            await c.query(
              `INSERT INTO photo (entity_type, entity_id, position, mime_type, width, height, image, thumbnail, caption, uploaded_by)
               SELECT 'material', $1,
                      coalesce((SELECT max(position) + 1 FROM photo WHERE entity_type = 'material' AND entity_id = $1), 0) + p.position,
                      p.mime_type, p.width, p.height, p.image, p.thumbnail, $3, $4
                 FROM photo p WHERE p.entity_type = 'inbound' AND p.entity_id = $2`,
              [m.id, id, `Recepción ${item.code}`, request.user!.id],
            );
          }
          // Herramientas y equipos: cada unidad es un contenido con su propio código (las copias se llevan la foto).
          const units = m.unitTracked ? await unitTargets(c, m, b.quantity, request.user!.id) : [m];
          for (const u of units.filter((x) => x.id !== m.id)) {
            await writeAudit(c, {
              userId: request.user!.id, action: 'material.alta', entityType: 'material', entityId: u.id,
              after: { ref: u.internalRef, unidad_de: m.internalRef, desde: item.code }, ip: request.ip, requestId: request.id,
            });
          }
          const quantity = m.unitTracked ? units.length : checkQuantity(m, b.quantity);
          const perLine = m.unitTracked ? 1 : quantity;
          if (m.lotTracked && !m.unitTracked && !b.lotCode?.trim()) throw badRequest(`${m.description} exige indicar el lote`, 'FALTA_LOTE');
          const lotId = m.unitTracked ? null : await findOrCreateLot(c, m.id, b.lotCode);
          const provisional: Place = await resolvePlace(c, { containerId: item.containerId, locationId: item.locationId })
            .catch(() => {
              throw conflict(`El sitio provisional ${item.placeCode} ya no admite contenido`, 'SITIO_NO_VALIDO');
            });
          // El proyecto se elige de la lista; si no se indica, se queda el de la recepción.
          const projectId = b.projectId !== undefined ? b.projectId : item.projectId;
          const pj = projectId ? (await c.query(`SELECT code || ' · ' || name AS label FROM project WHERE id = $1`, [projectId])).rows[0] : null;
          if (projectId && !pj) throw badRequest('El proyecto no existe', 'PROYECTO_NO_VALIDO');
          const project = pj?.label ?? (b.projectRef?.trim() || null);
          const usage = b.usagePlace?.trim() || null;
          const extra = [project && `proyecto ${project}`, usage && `uso: ${usage}`].filter(Boolean).join(' · ');
          const what = m.unitTracked
            ? `${units.length === 1 ? m.description : `${units.length} unidades de ${m.description}`} (${units.map((u) => u.internalRef).join(', ')})`
            : quantity === null ? m.description : `${fmt(quantity, m.unitCode)} de ${m.description}`;

          let final: Place | null = null;
          let receiptId: string;
          let withdrawalId: string | null = null;
          if (b.disposition === 'STORE') {
            final = b.containerId || b.locationId ? await resolvePlace(c, b) : provisional;
            const mv = await createMovement(c, {
              type: 'RECEIPT', userId: request.user!.id, reason: `Recepción ${item.code}${extra ? ` · ${extra}` : ''}`,
            });
            for (const [n, u] of units.entries()) {
              await applyLine(c, mv, n + 1, { material: u, lotId, containerId: final.containerId, locationId: final.locationId, delta: perLine, presence: true });
            }
            receiptId = mv.id;
          } else {
            // Se despliega del tirón: entra y sale, para que quede la huella de que llegó y adónde fue.
            const before = await c.query(
              `SELECT 1 FROM stock_balance WHERE material_id = $1 AND lot_id IS NOT DISTINCT FROM $2
                  AND container_id IS NOT DISTINCT FROM $3 AND location_id IS NOT DISTINCT FROM $4`,
              [m.id, lotId, provisional.containerId, provisional.locationId],
            );
            const mv = await createMovement(c, { type: 'RECEIPT', userId: request.user!.id, reason: `Recepción ${item.code}${extra ? ` · ${extra}` : ''}` });
            for (const [n, u] of units.entries()) {
              await applyLine(c, mv, n + 1, { material: u, lotId, containerId: provisional.containerId, locationId: provisional.locationId, delta: perLine, presence: true });
            }
            const out = await createMovement(c, {
              type: 'WITHDRAWAL', userId: request.user!.id, reason: `Desplegado directamente (recepción ${item.code})${usage ? ` en ${usage}` : ''}`,
            });
            for (const [n, u] of units.entries()) {
              await applyLine(c, out, n + 1, {
                material: u, lotId, containerId: provisional.containerId, locationId: provisional.locationId,
                delta: perLine === null ? null : -perLine, presence: m.unitTracked ? false : Boolean(before.rowCount),
              });
            }
            receiptId = mv.id;
            withdrawalId = out.id;
          }


          await c.query(
            `UPDATE inbound_item
                SET status = 'DONE', material_id = $2, quantity = $3, lot_code = $4, project_ref = $5, usage_place = $6,
                    disposition = $7, final_container_id = $8, final_location_id = $9, completion_note = $10,
                    completed_by = $11, completed_at = now(), receipt_movement_id = $12, withdrawal_movement_id = $13, project_id = $14
              WHERE id = $1`,
            [id, m.id, quantity, b.lotCode?.trim() || null, projectId ? null : project, usage, b.disposition, final?.containerId ?? null,
              final?.locationId ?? null, b.note?.trim() || null, request.user!.id, receiptId, withdrawalId, projectId ?? null],
          );
          // Los avisos de esta recepción ya no hace falta atenderlos (tampoco los de los demás responsables del proyecto).
          await c.query(
            `UPDATE notification SET read_at = coalesce(read_at, now())
              WHERE inbound_id = $1 AND read_at IS NULL AND user_id <> $2`,
            [id, item.receivedById],
          );

          // Aviso a quien la recibió: qué es y qué hacer con ello.
          const moved = final && (final.containerId !== provisional.containerId || final.locationId !== provisional.locationId);
          const todo = b.disposition === 'DEPLOY'
            ? `Se despliega directamente${usage ? ` en ${usage}` : ''}: no se guarda en el almacén.`
            : moved
              ? `Hay que llevarlo de ${provisional.code} a ${final!.code}.`
              : `Se queda guardado en ${provisional.code}.`;
          const message = `Identificado: ${what}${project ? ` (proyecto ${project})` : ''}. ${todo}${b.note?.trim() ? ` Nota: ${b.note.trim()}` : ''}`;
          if (item.receivedById !== request.user!.id) await notify(c, item.receivedById, id, message, request.user!.id);

          await audit(c, request, 'recepcion.identificada', id, {
            recepcion: item.code, material: m.internalRef, cantidad: quantity, lote: b.lotCode ?? null, proyecto: project,
            uso: usage, destino: b.disposition === 'DEPLOY' ? 'despliegue directo' : final!.code, foto_al_material: b.usePhotoForMaterial,
          });
          reply.code(201);
          return { message, materialId: m.id, finalPlaceCode: final?.code ?? null, units: m.unitTracked ? units.map((u) => ({ id: u.id, internalRef: u.internalRef })) : undefined };
        });
      }),
  );

  // ---- Reasignar: «no es mío, es de…» --------------------------------------
  app.post(
    '/api/inbound/:id/reassign',
    {
      preHandler: requireAuth(),
      schema: {
        params: idParams,
        body: { type: 'object', required: ['responsibleUserId'], additionalProperties: false, properties: { responsibleUserId: uuid, note: text(500) } },
      },
    },
    (request, reply) =>
      idempotent(pool, request, reply, async () => {
        const { id } = request.params as { id: string };
        const b = request.body as { responsibleUserId: string; note?: string };
        return withTransaction(pool, async (c) => {
          const item = await lockPending(c, id);
          const me = request.user!.id;
          if (![item.responsibleId, item.receivedById].includes(me) && !isManager(request) && !(await isProjectResponsible(c, item.projectId, me))) {
            throw forbidden('Solo el responsable, quien la recibió o un responsable de almacén puede reasignarla');
          }
          if (b.responsibleUserId === item.responsibleId) throw badRequest('Ya es el responsable', 'MISMO_RESPONSABLE');
          const name = await activeUser(c, b.responsibleUserId);
          await c.query(`UPDATE inbound_item SET responsible_user_id = $2 WHERE id = $1`, [id, b.responsibleUserId]);
          await c.query(`UPDATE notification SET read_at = coalesce(read_at, now()) WHERE inbound_id = $1 AND user_id = $2`, [id, item.responsibleId]);
          if (b.responsibleUserId !== me) {
            await notify(
              c, b.responsibleUserId, id,
              `Te han pasado una recepción que está en ${item.placeCode}. Indica qué es y qué se hace con ello.` +
                (b.note?.trim() ? ` Nota: ${b.note.trim()}` : ''),
              me,
            );
          }
          await audit(c, request, 'recepcion.reasignada', id, { recepcion: item.code, nuevo_responsable: name, nota: b.note ?? null });
          return { ok: true, responsible: name };
        });
      }),
  );

  // ---- Anular -------------------------------------------------------------
  app.post(
    '/api/inbound/:id/cancel',
    {
      preHandler: requireAuth(),
      schema: {
        params: idParams,
        body: { type: 'object', required: ['reason'], additionalProperties: false, properties: { reason: { type: 'string', minLength: 1, maxLength: 500 } } },
      },
    },
    (request, reply) =>
      idempotent(pool, request, reply, async () => {
        const { id } = request.params as { id: string };
        const { reason } = request.body as { reason: string };
        if (!reason.trim()) throw badRequest('Indica el motivo');
        return withTransaction(pool, async (c) => {
          const item = await lockPending(c, id);
          if (item.receivedById !== request.user!.id && !isManager(request)) {
            throw forbidden('Solo quien la registró o un responsable de almacén puede anularla');
          }
          await c.query(
            `UPDATE inbound_item SET status = 'CANCELLED', cancel_reason = $2, cancelled_by = $3, cancelled_at = now() WHERE id = $1`,
            [id, reason.trim(), request.user!.id],
          );
          await c.query(`UPDATE notification SET read_at = coalesce(read_at, now()) WHERE inbound_id = $1 AND read_at IS NULL`, [id]);
          await audit(c, request, 'recepcion.anulada', id, { recepcion: item.code, motivo: reason.trim() });
          return { ok: true };
        });
      }),
  );
}
