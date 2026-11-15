import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { writeAudit } from '../audit.js';
import { requirePermission } from '../auth/guard.js';
import { withTransaction } from '../db/tx.js';
import { badRequest, conflict, notFound } from '../errors.js';
import { idempotent } from '../idempotency.js';
import {
  applyLine, assertCanTake, checkQuantity, createMovement, getMaterial, lockBalance, placeCode, resolvePlace,
} from '../inventory/stock.js';
import { recordContainerMove } from '../warehouse/containers.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const code = (n: number) => `SAL-${String(n).padStart(6, '0')}`;

/** Una salida con lo que salió, de dónde, y si está vencida. */
const DEPARTURE_SELECT = `
  SELECT d.id, d.number, 'SAL-' || lpad(d.number::text, 6, '0') AS code, d.kind, d.status, d.destination, d.reason,
         d.due_at AS "dueAt", d.created_at AS "createdAt", d.returned_at AS "returnedAt",
         (d.status = 'OUT' AND d.due_at < now()) AS overdue,
         d.container_id AS "containerId", k.code AS "containerCode", k.description AS "containerDescription",
         d.kept_container_id AS "keptContainerId", kk.code AS "keptContainerCode",
         coalesce(fl.code, fp.code) AS "fromCode",
         d.responsible_user_id AS "responsibleId", ru.full_name AS "responsibleName",
         cu.full_name AS "createdByName", bu.full_name AS "returnedByName",
         coalesce((SELECT json_agg(json_build_object(
                     'materialId', l.material_id, 'internalRef', m.internal_ref, 'description', m.description,
                     'quantity', l.quantity::float, 'unitCode', m.unit_code,
                     'fromCode', coalesce(lk.code, ll.code)) ORDER BY m.description)
                     FROM departure_line l JOIN material m ON m.id = l.material_id
                     LEFT JOIN container lk ON lk.id = l.from_container_id
                     LEFT JOIN storage_location ll ON ll.id = l.from_location_id
                    WHERE l.departure_id = d.id), '[]') AS lines
    FROM departure d
    LEFT JOIN container k ON k.id = d.container_id
    LEFT JOIN container kk ON kk.id = d.kept_container_id
    LEFT JOIN storage_location fl ON fl.id = d.from_location_id
    LEFT JOIN container fp ON fp.id = d.from_parent_container_id
    JOIN app_user ru ON ru.id = d.responsible_user_id
    JOIN app_user cu ON cu.id = d.created_by
    LEFT JOIN app_user bu ON bu.id = d.returned_by`;

/** Fin del día elegido (o dentro de N días), a las 20:00. */
function dueFrom(b: { dueDate?: string; days?: number }): Date {
  let due: Date;
  if (b.dueDate) due = new Date(`${b.dueDate}T20:00:00`);
  else if (b.days) {
    due = new Date();
    due.setDate(due.getDate() + b.days);
    due.setHours(20, 0, 0, 0);
  } else throw badRequest('Indica cuánto tiempo va a estar fuera', 'SIN_FECHA');
  if (due.getTime() <= Date.now()) throw badRequest('La fecha de vuelta tiene que ser posterior a ahora', 'FECHA_PASADA');
  return due;
}

/**
 * Avisa a los responsables de las salidas temporales vencidas para que
 * indiquen si ha regresado a las instalaciones de IDOM. Un aviso por salida
 * (y otro si se amplía el plazo y vuelve a vencer).
 */
export async function notifyDueDepartures(pool: pg.Pool): Promise<number> {
  const r = await pool.query(
    `WITH due AS (
       UPDATE departure SET due_notified_at = now()
        WHERE status = 'OUT' AND due_at < now() AND due_notified_at IS NULL
        RETURNING id, number, responsible_user_id, created_by, destination, due_at, container_id
     )
     INSERT INTO notification (user_id, departure_id, message, created_by)
     SELECT due.responsible_user_id, due.id,
            'La salida temporal SAL-' || lpad(due.number::text, 6, '0') ||
            coalesce(' (' || k.code || ')', '') || ' a ' || due.destination ||
            ' tenía que volver el ' || to_char(due.due_at AT TIME ZONE 'Europe/Madrid', 'DD/MM/YYYY') ||
            '. ¿Ha regresado a las instalaciones de IDOM?',
            due.created_by
       FROM due LEFT JOIN container k ON k.id = due.container_id
     RETURNING id`,
  );
  return r.rowCount ?? 0;
}

export function departureRoutes(app: FastifyInstance, deps: { pool: pg.Pool }) {
  const { pool } = deps;

  app.get(
    '/api/departures',
    {
      preHandler: requirePermission('stock.read'),
      schema: { querystring: { type: 'object', additionalProperties: false, properties: { all: { type: 'boolean', default: false } } } },
    },
    async (request) => {
      await notifyDueDepartures(pool);
      const { all } = request.query as { all: boolean };
      const r = await pool.query(
        `${DEPARTURE_SELECT} WHERE ($1 OR d.status = 'OUT')
          ORDER BY (d.status = 'OUT') DESC, CASE WHEN d.status = 'OUT' THEN d.due_at END, d.created_at DESC LIMIT 500`,
        [all],
      );
      return { departures: r.rows };
    },
  );

  app.get('/api/departures/:id', { preHandler: requirePermission('stock.read'), schema: { params: idParams } }, async (request) => {
    const r = await pool.query(`${DEPARTURE_SELECT} WHERE d.id = $1`, [(request.params as { id: string }).id]);
    if (!r.rows[0]) throw notFound('La salida no existe');
    return { departure: r.rows[0] };
  });

  // ---- Registrar una salida ------------------------------------------------
  app.post(
    '/api/departures',
    {
      preHandler: requirePermission('stock.withdraw'),
      schema: {
        body: {
          type: 'object', required: ['kind', 'destination'], additionalProperties: false,
          properties: {
            kind: { type: 'string', enum: ['DEFINITIVE', 'TEMPORARY'] },
            destination: { type: 'string', minLength: 1, maxLength: 200 },
            reason: { type: 'string', maxLength: 300 },
            dueDate: { type: 'string', format: 'date' },
            days: { type: 'integer', minimum: 1, maximum: 730 },
            responsibleUserId: uuid,
            containerId: uuid,
            keepContainer: { type: 'boolean' },
            lines: {
              type: 'array', maxItems: 100,
              items: {
                type: 'object', required: ['balanceId'], additionalProperties: false,
                properties: { balanceId: uuid, quantity: { type: 'number', exclusiveMinimum: 0 } },
              },
            },
          },
        },
      },
    },
    (request, reply) =>
      idempotent(pool, request, reply, async () => {
        const b = request.body as {
          kind: 'DEFINITIVE' | 'TEMPORARY'; destination: string; reason?: string; dueDate?: string; days?: number;
          responsibleUserId?: string; containerId?: string; keepContainer?: boolean; lines?: Array<{ balanceId: string; quantity?: number }>;
        };
        const temporary = b.kind === 'TEMPORARY';
        const destination = b.destination.trim();
        if (!destination) throw badRequest('Indica a dónde va', 'SIN_DESTINO');
        if (!temporary && !b.reason?.trim()) throw badRequest('Indica el motivo de la salida definitiva', 'SIN_MOTIVO');
        if (Boolean(b.containerId) === Boolean(b.lines?.length)) {
          throw badRequest('Elige un contenedor entero o el contenido que sale', 'QUE_SALE');
        }
        const due = temporary ? dueFrom(b) : null;
        const userId = request.user!.id;
        const responsibleId = b.responsibleUserId ?? userId;

        const out = await withTransaction(pool, async (c) => {
          const resp = await c.query(`SELECT full_name FROM app_user WHERE id = $1 AND active AND deleted_at IS NULL`, [responsibleId]);
          if (!resp.rowCount) throw badRequest('El responsable indicado no existe', 'USUARIO_NO_EXISTE');
          const what = temporary ? `Salida temporal a ${destination}` : `Salida definitiva a ${destination}`;
          const reason = [what, b.reason?.trim()].filter(Boolean).join(': ');
          let containerCode: string | null = null;
          let from: { location: string | null; parent: string | null } = { location: null, parent: null };
          let movementId: string | null = null;
          let movementNumber: number | null = null;
          const lines: Array<{ materialId: string; lotId: string | null; quantity: number | null; containerId: string | null; locationId: string | null }> = [];
          const touched = new Set<string>();
          let keptCode: string | null = null;
          let keptId: string | null = null;
          let lineInput = b.lines ?? [];

          if (b.containerId && b.keepContainer) {
            // El contenedor se queda para reutilizarlo: sale lo que lleva dentro (también lo de los contenedores de dentro).
            const k = (await c.query(`SELECT code, status FROM container WHERE id = $1 FOR UPDATE`, [b.containerId])).rows[0];
            if (!k) throw notFound('El contenedor no existe');
            if (k.status !== 'ACTIVE') throw conflict(`${k.code} no está en el taller`, 'CONTENEDOR_NO_ACTIVO');
            const bals = (await c.query(
              `WITH RECURSIVE down AS (
                 SELECT id FROM container WHERE id = $1
                 UNION ALL SELECT k.id FROM container k JOIN down ON k.parent_container_id = down.id WHERE k.status = 'ACTIVE'
               ) SELECT b.id FROM stock_balance b JOIN down ON down.id = b.container_id ORDER BY b.id`,
              [b.containerId],
            )).rows.map((x) => ({ balanceId: x.id as string }));
            if (!bals.length) throw conflict(`${k.code} está vacío: no sale nada`, 'CONTENEDOR_VACIO');
            lineInput = bals;
            keptCode = k.code;
            keptId = b.containerId;
          }

          if (b.containerId && !b.keepContainer) {
            const k = (await c.query(`SELECT code, status, location_id, parent_container_id FROM container WHERE id = $1 FOR UPDATE`, [b.containerId])).rows[0];
            if (!k) throw notFound('El contenedor no existe');
            if (k.status === 'OUT') throw conflict(`${k.code} ya está fuera del taller`, 'FUERA_DEL_TALLER');
            if (k.status !== 'ACTIVE') throw conflict(`${k.code} está retirado`, 'CONTENEDOR_RETIRADO');
            const root = (await c.query(
              `SELECT r.code FROM container_effective_location e JOIN container r ON r.id = e.root_container_id WHERE e.container_id = $1 AND r.status = 'OUT'`,
              [b.containerId],
            )).rows[0];
            if (root) throw conflict(`${k.code} va dentro de ${root.code}, que está fuera del taller`, 'FUERA_DEL_TALLER');
            await assertCanTake(c, request.user!, b.containerId, 'sacar');
            containerCode = k.code;
            from = { location: k.location_id, parent: k.parent_container_id };

            if (temporary) {
              await c.query(
                `UPDATE container SET status = 'OUT', location_id = NULL, parent_container_id = NULL, updated_at = now() WHERE id = $1`,
                [b.containerId],
              );
              movementNumber = await recordContainerMove(c, {
                userId, containerId: b.containerId, fromLocationId: k.location_id, fromParentId: k.parent_container_id,
                toLocationId: null, toParentId: null, reason,
              });
            } else {
              // Definitiva: sale todo lo que lleva (también lo de los contenedores de dentro) y quedan retirados.
              const tree = (await c.query(
                `WITH RECURSIVE down AS (
                   SELECT id FROM container WHERE id = $1
                   UNION ALL SELECT k.id FROM container k JOIN down ON k.parent_container_id = down.id WHERE k.status = 'ACTIVE'
                 ) SELECT id FROM down`,
                [b.containerId],
              )).rows.map((x) => x.id as string);
              const balances = (await c.query(
                `SELECT id, material_id, lot_id, container_id, quantity::float AS quantity FROM stock_balance WHERE container_id = ANY($1) FOR UPDATE`,
                [tree],
              )).rows;
              if (balances.length) {
                const mv = await createMovement(c, { type: 'EXIT', userId, reason });
                movementId = mv.id;
                movementNumber = mv.number;
                let n = 1;
                for (const bal of balances) {
                  const m = await getMaterial(c, bal.material_id);
                  await applyLine(c, mv, n++, {
                    material: m, lotId: bal.lot_id, containerId: bal.container_id, locationId: null,
                    delta: bal.quantity === null ? null : -bal.quantity, presence: false,
                  });
                  lines.push({ materialId: m.id, lotId: bal.lot_id, quantity: bal.quantity, containerId: bal.container_id, locationId: null });
                  if (m.unitTracked) await c.query(`UPDATE material SET status = 'OBSOLETE', updated_at = now() WHERE id = $1`, [m.id]);
                }
              }
              await c.query(
                `UPDATE container SET status = 'RETIRED', location_id = NULL, parent_container_id = NULL, retired_at = now(), updated_at = now()
                  WHERE id = ANY($1)`,
                [tree],
              );
              const n = await recordContainerMove(c, {
                userId, containerId: b.containerId, fromLocationId: k.location_id, fromParentId: k.parent_container_id,
                toLocationId: null, toParentId: null, reason,
              });
              movementNumber ??= n;
            }
          } else {
            const mv = await createMovement(c, { type: temporary ? 'EXIT_OUT' : 'EXIT', userId, reason });
            movementId = mv.id;
            movementNumber = mv.number;
            let n = 1;
            for (const line of lineInput) {
              const bal = await lockBalance(c, line.balanceId);
              await assertCanTake(c, request.user!, bal.containerId, 'sacar');
              const m = await getMaterial(c, bal.materialId);
              const quantity = m.tracking === 'NOT_TRACKED' ? null : checkQuantity(m, line.quantity ?? bal.quantity)!;
              const where = await placeCode(c, bal.containerId, bal.locationId);
              if (quantity !== null && quantity > (bal.quantity ?? 0)) {
                throw conflict(`Solo hay ${bal.quantity} ${m.unitCode} de ${m.description} en ${where}`, 'STOCK_INSUFICIENTE');
              }
              await applyLine(c, mv, n++, {
                material: m, lotId: bal.lotId, containerId: bal.containerId, locationId: bal.locationId,
                delta: quantity === null ? null : -quantity, presence: false,
              });
              lines.push({ materialId: m.id, lotId: bal.lotId, quantity, containerId: bal.containerId, locationId: bal.locationId });
              if (bal.containerId) touched.add(bal.containerId);
              if (!temporary && m.unitTracked) await c.query(`UPDATE material SET status = 'OBSOLETE', updated_at = now() WHERE id = $1`, [m.id]);
            }
          }

          const d = (await c.query(
            `INSERT INTO departure (kind, status, destination, reason, due_at, container_id, from_location_id, from_parent_container_id,
                                    responsible_user_id, created_by, out_movement_id, kept_container_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id, number`,
            [b.kind, temporary ? 'OUT' : 'DONE', destination, b.reason?.trim() || null, due, keptId ? null : b.containerId ?? null,
              from.location, from.parent, responsibleId, userId, movementId, keptId],
          )).rows[0];
          for (const l of lines) {
            await c.query(
              `INSERT INTO departure_line (departure_id, material_id, lot_id, quantity, from_container_id, from_location_id)
               VALUES ($1, $2, $3, $4, $5, $6)`,
              [d.id, l.materialId, l.lotId, l.quantity, l.containerId, l.locationId],
            );
          }
          await writeAudit(c, {
            userId, action: temporary ? 'salida.temporal' : 'salida.definitiva', entityType: 'departure', entityId: d.id,
            after: { salida: code(d.number), destino: destination, contenedor: containerCode, seQueda: keptCode, lineas: lines.length, vuelve: due?.toISOString() ?? null },
            ip: request.ip, requestId: request.id,
          });
          const touchedRows = touched.size
            ? (await c.query(`SELECT id, code FROM container WHERE id = ANY($1) AND status = 'ACTIVE' ORDER BY code`, [[...touched]])).rows
            : [];
          const thing = containerCode ?? (keptCode ? `el contenido de ${keptCode}` : `${lines.length} línea${lines.length === 1 ? '' : 's'} de contenido`);
          const kept = keptCode ? `. ${keptCode} se queda en el taller, vacío, para reutilizarlo` : '';
          return {
            id: d.id as string,
            code: code(d.number),
            movementNumber,
            containers: touchedRows,
            message: (temporary
              ? `${code(d.number)}: ${thing} sale a ${destination} hasta el ${due!.toLocaleDateString('es-ES')}`
              : `${code(d.number)}: ${thing} sale definitivamente a ${destination}`) + kept,
          };
        });
        reply.code(201);
        return out;
      }),
  );

  // ---- Registrar la vuelta -------------------------------------------------
  app.post(
    '/api/departures/:id/return',
    {
      preHandler: requirePermission('stock.withdraw'),
      schema: {
        params: idParams,
        body: { type: 'object', additionalProperties: false, properties: { toContainerId: uuid, toLocationId: uuid } },
      },
    },
    (request, reply) =>
      idempotent(pool, request, reply, async () => {
        const { id } = request.params as { id: string };
        const b = (request.body ?? {}) as { toContainerId?: string; toLocationId?: string };
        const userId = request.user!.id;
        return withTransaction(pool, async (c) => {
          const d = (await c.query(`SELECT * FROM departure WHERE id = $1 FOR UPDATE`, [id])).rows[0];
          if (!d) throw notFound('La salida no existe');
          if (d.status !== 'OUT') throw conflict('Esta salida ya está cerrada', 'SALIDA_CERRADA');
          const reason = `Vuelta de ${code(d.number)} (${d.destination})`;
          let movementNumber: number;
          let where: string;
          const touched: Array<{ id: string; code: string }> = [];

          if (d.container_id) {
            const k = (await c.query(`SELECT code FROM container WHERE id = $1 FOR UPDATE`, [d.container_id])).rows[0];
            const target = b.toContainerId || b.toLocationId
              ? { containerId: b.toContainerId ?? null, locationId: b.toLocationId ?? null }
              : { containerId: d.from_parent_container_id, locationId: d.from_location_id };
            if (target.containerId === d.container_id) throw badRequest('No puede volver dentro de sí mismo', 'SITIO_NO_VALIDO');
            const place = await resolvePlace(c, target, { forContent: false });
            await c.query(
              `UPDATE container SET status = 'ACTIVE', location_id = $2, parent_container_id = $3, updated_at = now() WHERE id = $1`,
              [d.container_id, place.locationId, place.containerId],
            );
            movementNumber = await recordContainerMove(c, {
              userId, containerId: d.container_id, fromLocationId: null, fromParentId: null,
              toLocationId: place.locationId, toParentId: place.containerId, reason,
            });
            where = place.code;
            touched.push({ id: d.container_id, code: k.code });
          } else {
            const lines = (await c.query(`SELECT * FROM departure_line WHERE departure_id = $1`, [id])).rows;
            const mv = await createMovement(c, { type: 'EXIT_RETURN', userId, reason });
            movementNumber = mv.number;
            const chosen = b.toContainerId || b.toLocationId ? await resolvePlace(c, { containerId: b.toContainerId, locationId: b.toLocationId }) : null;
            let n = 1;
            const codes = new Set<string>();
            for (const l of lines) {
              const m = await getMaterial(c, l.material_id);
              const place = chosen ?? await resolvePlace(c, { containerId: l.from_container_id, locationId: l.from_location_id });
              await applyLine(c, mv, n++, {
                material: m, lotId: l.lot_id, containerId: place.containerId, locationId: place.locationId,
                delta: l.quantity === null ? null : Number(l.quantity), presence: true,
              });
              codes.add(place.code);
              if (place.containerId && !touched.some((x) => x.id === place.containerId)) touched.push({ id: place.containerId, code: place.code });
            }
            where = [...codes].join(', ');
          }
          await c.query(`UPDATE departure SET status = 'RETURNED', returned_at = now(), returned_by = $2 WHERE id = $1`, [id, userId]);
          await c.query(`UPDATE notification SET read_at = coalesce(read_at, now()) WHERE departure_id = $1`, [id]);
          await writeAudit(c, {
            userId, action: 'salida.vuelta', entityType: 'departure', entityId: id,
            after: { salida: code(d.number), a: where }, ip: request.ip, requestId: request.id,
          });
          return { movementNumber, remaining: null, containers: touched, message: `${code(d.number)} ha vuelto. Guardado en ${where}` };
        });
      }),
  );

  // ---- Aún no ha vuelto: nuevo plazo ----------------------------------------
  app.post(
    '/api/departures/:id/extend',
    {
      preHandler: requirePermission('stock.withdraw'),
      schema: {
        params: idParams,
        body: {
          type: 'object', additionalProperties: false,
          properties: { dueDate: { type: 'string', format: 'date' }, days: { type: 'integer', minimum: 1, maximum: 730 } },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const due = dueFrom((request.body ?? {}) as { dueDate?: string; days?: number });
      return withTransaction(pool, async (c) => {
        const d = (await c.query(`SELECT number, status, due_at FROM departure WHERE id = $1 FOR UPDATE`, [id])).rows[0];
        if (!d) throw notFound('La salida no existe');
        if (d.status !== 'OUT') throw conflict('Esta salida ya está cerrada', 'SALIDA_CERRADA');
        await c.query(`UPDATE departure SET due_at = $2, due_notified_at = NULL WHERE id = $1`, [id, due]);
        await c.query(`UPDATE notification SET read_at = coalesce(read_at, now()) WHERE departure_id = $1`, [id]);
        await writeAudit(c, {
          userId: request.user!.id, action: 'salida.nuevo_plazo', entityType: 'departure', entityId: id,
          before: { vuelve: d.due_at }, after: { vuelve: due.toISOString() }, ip: request.ip, requestId: request.id,
        });
        return { ok: true, message: `${code(d.number)}: nuevo plazo hasta el ${due.toLocaleDateString('es-ES')}` };
      });
    },
  );
}
