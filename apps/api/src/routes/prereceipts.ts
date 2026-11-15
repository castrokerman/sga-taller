import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { writeAudit } from '../audit.js';
import { requireAuth, requirePermission } from '../auth/guard.js';
import { withTransaction } from '../db/tx.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';

/**
 * Pre-recepciones: quien espera un paquete lo anuncia. Al registrar una
 * recepción se proponen las abiertas que encajan con lo que se escribe.
 */

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const text = (max: number) => ({ type: 'string', maxLength: max }) as const;

export const PRE_SELECT = `
  SELECT r.id, r.number, 'PRE-' || lpad(r.number::text, 6, '0') AS code, r.status, r.description, r.supplier,
         r.order_ref AS "orderRef", r.project_id AS "projectId", p.code || ' · ' || p.name AS "projectLabel",
         r.expected_date AS "expectedDate", r.note, r.created_by AS "createdById", u.full_name AS "createdBy",
         r.created_at AS "createdAt", r.inbound_id AS "inboundId", r.received_at AS "receivedAt", r.cancelled_at AS "cancelledAt",
         (r.status = 'OPEN' AND r.expected_date IS NOT NULL AND r.expected_date < current_date) AS late,
         CASE WHEN r.inbound_id IS NULL THEN NULL ELSE (SELECT 'REC-' || lpad(i.number::text, 6, '0') FROM inbound_item i WHERE i.id = r.inbound_id) END AS "inboundCode"
    FROM pre_receipt r
    JOIN app_user u ON u.id = r.created_by
    LEFT JOIN project p ON p.id = r.project_id`;

const normalize = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const isManager = (request: FastifyRequest) => request.user!.permissions.includes('inbound.manage');

export function preReceiptRoutes(app: FastifyInstance, deps: { pool: pg.Pool }) {
  const { pool } = deps;

  // Mis pre-recepciones (todas) y, para quien gestiona el almacén, todas las abiertas.
  app.get(
    '/api/pre-receipts',
    {
      preHandler: requireAuth(),
      schema: {
        querystring: {
          type: 'object', additionalProperties: false,
          properties: { scope: { type: 'string', enum: ['mine', 'open'], default: 'mine' } },
        },
      },
    },
    async (request) => {
      const { scope } = request.query as { scope: 'mine' | 'open' };
      const open = scope === 'open' && (isManager(request) || request.user!.permissions.includes('stock.receive'));
      const r = open
        ? await pool.query(`${PRE_SELECT} WHERE r.status = 'OPEN' ORDER BY r.expected_date NULLS LAST, r.created_at`)
        : await pool.query(
          `${PRE_SELECT} WHERE r.created_by = $1 ORDER BY (r.status = 'OPEN') DESC, r.created_at DESC LIMIT 200`,
          [request.user!.id],
        );
      return { items: r.rows, canSeeAll: isManager(request) || request.user!.permissions.includes('stock.receive') };
    },
  );

  // Sugerencias para quien registra una recepción: primero las que coinciden con
  // lo escrito (proveedor, pedido, descripción); después, las de fecha más cercana.
  app.get(
    '/api/pre-receipts/suggest',
    {
      preHandler: requirePermission('stock.receive'),
      schema: { querystring: { type: 'object', additionalProperties: false, properties: { q: text(300) } } },
    },
    async (request) => {
      const { q } = request.query as { q?: string };
      const r = await pool.query(`${PRE_SELECT} WHERE r.status = 'OPEN'`);
      const words = normalize(q ?? '').split(/[^a-z0-9]+/).filter((w) => w.length >= 2);
      const today = Date.now();
      const scored = r.rows.map((x) => {
        const hay = normalize([x.description, x.supplier, x.orderRef, x.createdBy, x.projectLabel, x.note].filter(Boolean).join(' '));
        const score = words.filter((w) => hay.includes(w)).length;
        const days = x.expectedDate ? Math.abs(new Date(x.expectedDate).getTime() - today) / 86_400_000 : 9999;
        return { ...x, score, days };
      });
      scored.sort((a, b) => b.score - a.score || a.days - b.days);
      return { items: scored.slice(0, 8).map(({ days: _d, ...x }) => x) };
    },
  );

  app.post(
    '/api/pre-receipts',
    {
      preHandler: requireAuth(),
      schema: {
        body: {
          type: 'object', required: ['description'], additionalProperties: false,
          properties: {
            description: { type: 'string', minLength: 1, maxLength: 500 },
            supplier: text(150), orderRef: text(80), note: text(1000),
            projectId: { anyOf: [{ type: 'null' }, uuid] },
            expectedDate: { anyOf: [{ type: 'null' }, { type: 'string', format: 'date' }] },
          },
        },
      },
    },
    async (request, reply) => {
      const b = request.body as { description: string; supplier?: string; orderRef?: string; note?: string; projectId?: string | null; expectedDate?: string | null };
      if (!b.description.trim()) throw badRequest('Indica qué esperas que llegue', 'FALTA_DESCRIPCION');
      const out = await withTransaction(pool, async (c) => {
        if (b.projectId && !(await c.query(`SELECT 1 FROM project WHERE id = $1 AND status <> 'CLOSED'`, [b.projectId])).rowCount) {
          throw badRequest('El proyecto no existe o está cerrado', 'PROYECTO_NO_VALIDO');
        }
        const r = await c.query(
          `INSERT INTO pre_receipt (description, supplier, order_ref, note, project_id, expected_date, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, 'PRE-' || lpad(number::text, 6, '0') AS code`,
          [b.description.trim(), b.supplier?.trim() || null, b.orderRef?.trim() || null, b.note?.trim() || null,
            b.projectId ?? null, b.expectedDate ?? null, request.user!.id],
        );
        await writeAudit(c, {
          userId: request.user!.id, action: 'prerecepcion.alta', entityType: 'pre_receipt', entityId: r.rows[0].id,
          after: { codigo: r.rows[0].code, ...b }, ip: request.ip, requestId: request.id,
        });
        return r.rows[0];
      });
      reply.code(201);
      return out;
    },
  );

  app.post(
    '/api/pre-receipts/:id/cancel',
    { preHandler: requireAuth(), schema: { params: idParams } },
    async (request) => {
      const { id } = request.params as { id: string };
      return withTransaction(pool, async (c) => {
        const r = (await c.query(`SELECT created_by, status, 'PRE-' || lpad(number::text, 6, '0') AS code FROM pre_receipt WHERE id = $1 FOR UPDATE`, [id])).rows[0];
        if (!r) throw notFound('La pre-recepción no existe');
        if (r.created_by !== request.user!.id && !isManager(request)) throw forbidden('Solo quien la creó o un responsable de almacén puede cancelarla');
        if (r.status !== 'OPEN') throw conflict('Esta pre-recepción ya está cerrada', 'PRERECEPCION_CERRADA');
        await c.query(`UPDATE pre_receipt SET status = 'CANCELLED', cancelled_at = now(), cancelled_by = $2 WHERE id = $1`, [id, request.user!.id]);
        await writeAudit(c, {
          userId: request.user!.id, action: 'prerecepcion.cancelada', entityType: 'pre_receipt', entityId: id,
          after: { codigo: r.code }, ip: request.ip, requestId: request.id,
        });
        return { ok: true };
      });
    },
  );
}
