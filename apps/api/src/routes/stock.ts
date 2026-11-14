import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { writeAudit } from '../audit.js';
import { requirePermission } from '../auth/guard.js';
import { withTransaction } from '../db/tx.js';
import { AppError, badRequest, conflict, forbidden, notFound } from '../errors.js';
import { idempotent } from '../idempotency.js';
import {
  applyLine, checkQuantity, createMovement, emptyDisposable, findOrCreateLot, getMaterial, lockBalance, placeCode, resolvePlace,
  type Balance, type MaterialInfo,
} from '../inventory/stock.js';
import { getParameter } from '../warehouse/queries.js';
import { BALANCE_SELECT, LOAN_SELECT, MOVEMENT_LINE_SELECT } from './materials.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const qty = { type: 'number', exclusiveMinimum: 0, maximum: 1e12 } as const;
const text = (max: number) => ({ type: 'string', maxLength: max }) as const;

const fmt = (n: number | null, unit: string) =>
  n === null ? '' : `${n.toLocaleString('es-ES', { maximumFractionDigits: 4 })} ${unit}`;

/** Una retirada o un traslado no puede tocar lo restringido a un proyecto: eso necesita autorización. */
function checkFree(b: Balance, m: MaterialInfo, quantity: number) {
  if (m.tracking === 'NOT_TRACKED' || b.quantity === null || b.free === null) return;
  if (quantity > b.free && b.free < b.quantity) {
    throw new AppError(
      409,
      'MATERIAL_RESTRINGIDO',
      `Solo ${fmt(b.free, m.unitCode)} están libres; el resto está restringido a un proyecto y necesita autorización`,
    );
  }
}

/** Lo que se devuelve tras cada operación: el saldo que queda y avisos. */
interface OpResult {
  movementNumber: number;
  message: string;
  remaining: number | null;
  needsRecount?: boolean;
  emptyDisposable?: string | null;
}

export function stockRoutes(app: FastifyInstance, deps: { pool: pg.Pool }) {
  const { pool } = deps;
  const audit = (c: pg.PoolClient, request: FastifyRequest, action: string, entityId: string, after: unknown) =>
    writeAudit(c, { userId: request.user!.id, action, entityType: 'stock_movement', entityId, after, ip: request.ip, requestId: request.id });

  // ---- Consulta -----------------------------------------------------------
  // Material de un contenedor o de una ubicación.
  app.get(
    '/api/stock',
    {
      preHandler: requirePermission('stock.read'),
      schema: {
        querystring: { type: 'object', additionalProperties: false, properties: { containerId: uuid, locationId: uuid } },
      },
    },
    async (request) => {
      const q = request.query as { containerId?: string; locationId?: string };
      if (Boolean(q.containerId) === Boolean(q.locationId)) throw badRequest('Indica un contenedor o una ubicación');
      const r = await pool.query(
        `${BALANCE_SELECT} WHERE ${q.containerId ? 'b.container_id' : 'b.location_id'} = $1 ORDER BY m.description, l.lot_code`,
        [q.containerId ?? q.locationId],
      );
      return { stock: r.rows };
    },
  );

  app.get(
    '/api/stock/movements',
    {
      preHandler: requirePermission('stock.read'),
      schema: {
        querystring: {
          type: 'object', additionalProperties: false,
          properties: { limit: { type: 'integer', minimum: 1, maximum: 2000, default: 300 } },
        },
      },
    },
    async (request) => {
      const { limit } = request.query as { limit: number };
      const r = await pool.query(
        `${MOVEMENT_LINE_SELECT} ORDER BY mv.movement_number DESC, ml.line_no LIMIT $1`,
        [limit],
      );
      return { movements: r.rows };
    },
  );

  // ---- Entrada y devolución ----------------------------------------------
  app.post(
    '/api/stock/receipt',
    {
      preHandler: requirePermission('stock.receive'),
      schema: {
        body: {
          type: 'object', required: ['materialId'], additionalProperties: false,
          properties: {
            materialId: uuid, containerId: uuid, locationId: uuid, quantity: qty,
            lotCode: text(60), reason: text(300), externalReference: text(80),
            isReturn: { type: 'boolean', default: false },
          },
        },
      },
    },
    (request, reply) =>
      idempotent(pool, request, reply, async (): Promise<OpResult> => {
        const b = request.body as {
          materialId: string; containerId?: string; locationId?: string; quantity?: number; lotCode?: string;
          reason?: string; externalReference?: string; isReturn: boolean;
        };
        if (b.isReturn && !request.user!.permissions.includes('stock.return')) throw forbidden();
        const out = await withTransaction(pool, async (c) => {
          const m = await getMaterial(c, b.materialId);
          if (m.status !== 'ACTIVE') throw conflict('El material está dado de baja', 'MATERIAL_OBSOLETO');
          const place = await resolvePlace(c, b);
          const quantity = checkQuantity(m, b.quantity);
          if (m.lotTracked && !b.lotCode?.trim()) throw badRequest(`${m.description} exige indicar el lote`, 'FALTA_LOTE');
          const lotId = await findOrCreateLot(c, m.id, b.lotCode);
          const mv = await createMovement(c, {
            type: b.isReturn ? 'RETURN' : 'RECEIPT', userId: request.user!.id, reason: b.reason, externalReference: b.externalReference,
          });
          const after = await applyLine(c, mv, 1, {
            material: m, lotId, containerId: place.containerId, locationId: place.locationId, delta: quantity, presence: true,
          });
          await audit(c, request, b.isReturn ? 'stock.devolucion' : 'stock.entrada', mv.id, {
            movimiento: mv.number, material: m.internalRef, sitio: place.code, cantidad: quantity, lote: b.lotCode ?? null,
          });
          return {
            movementNumber: mv.number,
            remaining: after,
            message: `${b.isReturn ? 'Devolución' : 'Entrada'} registrada: ${quantity === null ? m.description : `${fmt(quantity, m.unitCode)} de ${m.description}`} en ${place.code}`,
          };
        });
        reply.code(201);
        return out;
      }),
  );

  // ---- Retirada -----------------------------------------------------------
  app.post(
    '/api/stock/withdraw',
    {
      preHandler: requirePermission('stock.withdraw'),
      schema: {
        body: {
          type: 'object', required: ['balanceId'], additionalProperties: false,
          properties: { balanceId: uuid, quantity: qty, reason: text(300), exhausted: { type: 'boolean', default: false } },
        },
      },
    },
    (request, reply) =>
      idempotent(pool, request, reply, async (): Promise<OpResult> => {
        const b = request.body as { balanceId: string; quantity?: number; reason?: string; exhausted: boolean };
        return withTransaction(pool, async (c) => {
          const bal = await lockBalance(c, b.balanceId);
          const m = await getMaterial(c, bal.materialId);
          const code = await placeCode(c, bal.containerId, bal.locationId);
          const mv = await createMovement(c, { type: 'WITHDRAWAL', userId: request.user!.id, reason: b.reason });

          let taken: number | null = null;
          let note = '';
          if (m.tracking === 'NOT_TRACKED') {
            await applyLine(c, mv, 1, { material: m, lotId: bal.lotId, containerId: bal.containerId, locationId: bal.locationId, delta: null, presence: !b.exhausted });
            if (b.exhausted) note = '. Marcado como agotado en ese sitio';
          } else {
            const wanted = checkQuantity(m, b.quantity)!;
            checkFree(bal, m, wanted);
            if (m.tracking === 'EXACT') {
              if (wanted > bal.quantity!) {
                throw conflict(`Solo hay ${fmt(bal.quantity, m.unitCode)} en ${code}`, 'STOCK_INSUFICIENTE');
              }
              taken = wanted;
            } else {
              // Estimado: se puede retirar hasta cero y se pide recuento.
              taken = Math.min(wanted, bal.quantity!);
              if (wanted > bal.quantity!) note = `. Según el sistema quedaban ${fmt(bal.quantity, m.unitCode)}: se ha dejado a cero y conviene recontar`;
            }
            await applyLine(c, mv, 1, { material: m, lotId: bal.lotId, containerId: bal.containerId, locationId: bal.locationId, delta: -taken });
          }
          const remaining = m.tracking === 'NOT_TRACKED' ? null : Math.max(0, (bal.quantity ?? 0) - (taken ?? 0));
          await audit(c, request, 'stock.retirada', mv.id, {
            movimiento: mv.number, material: m.internalRef, sitio: code, cantidad: taken, motivo: b.reason ?? null,
          });
          return {
            movementNumber: mv.number,
            remaining,
            needsRecount: m.tracking === 'ESTIMATED' && remaining === 0,
            emptyDisposable: await emptyDisposable(c, bal.containerId),
            message: `Retirado${taken === null ? `: ${m.description}` : ` ${fmt(taken, m.unitCode)} de ${m.description}`} de ${code}${note}`,
          };
        });
      }),
  );

  // ---- Traslado -----------------------------------------------------------
  app.post(
    '/api/stock/transfer',
    {
      preHandler: requirePermission('stock.transfer'),
      schema: {
        body: {
          type: 'object', required: ['balanceId'], additionalProperties: false,
          properties: { balanceId: uuid, quantity: qty, toContainerId: uuid, toLocationId: uuid, reason: text(300) },
        },
      },
    },
    (request, reply) =>
      idempotent(pool, request, reply, async (): Promise<OpResult> => {
        const b = request.body as { balanceId: string; quantity?: number; toContainerId?: string; toLocationId?: string; reason?: string };
        return withTransaction(pool, async (c) => {
          const bal = await lockBalance(c, b.balanceId);
          const m = await getMaterial(c, bal.materialId);
          const from = await placeCode(c, bal.containerId, bal.locationId);
          const to = await resolvePlace(c, { containerId: b.toContainerId, locationId: b.toLocationId });
          if (to.containerId === bal.containerId && to.locationId === bal.locationId) {
            throw conflict(`El material ya está en ${to.code}`, 'MISMO_LUGAR');
          }
          const quantity = m.tracking === 'NOT_TRACKED' ? null : checkQuantity(m, b.quantity ?? bal.quantity)!;
          if (quantity !== null) {
            checkFree(bal, m, quantity);
            if (quantity > bal.quantity!) throw conflict(`Solo hay ${fmt(bal.quantity, m.unitCode)} en ${from}`, 'STOCK_INSUFICIENTE');
          }
          const mv = await createMovement(c, { type: 'TRANSFER', userId: request.user!.id, reason: b.reason });
          await applyLine(c, mv, 1, { material: m, lotId: bal.lotId, containerId: bal.containerId, locationId: bal.locationId, delta: quantity === null ? null : -quantity, presence: false });
          await applyLine(c, mv, 2, { material: m, lotId: bal.lotId, containerId: to.containerId, locationId: to.locationId, delta: quantity, presence: true });
          await audit(c, request, 'stock.traslado', mv.id, { movimiento: mv.number, material: m.internalRef, de: from, a: to.code, cantidad: quantity });
          return {
            movementNumber: mv.number,
            remaining: quantity === null ? null : bal.quantity! - quantity,
            emptyDisposable: await emptyDisposable(c, bal.containerId),
            message: `${quantity === null ? m.description : `${fmt(quantity, m.unitCode)} de ${m.description}`} trasladado de ${from} a ${to.code}`,
          };
        });
      }),
  );

  // ---- Recuento -----------------------------------------------------------
  app.post(
    '/api/stock/count',
    {
      preHandler: requirePermission('stock.count'),
      schema: {
        body: {
          type: 'object', required: ['balanceId'], additionalProperties: false,
          properties: {
            balanceId: uuid,
            counted: { type: 'number', minimum: 0, maximum: 1e12 },
            present: { type: 'boolean' },
            reason: text(300),
          },
        },
      },
    },
    (request, reply) =>
      idempotent(pool, request, reply, async (): Promise<OpResult> => {
        const b = request.body as { balanceId: string; counted?: number; present?: boolean; reason?: string };
        return withTransaction(pool, async (c) => {
          const bal = await lockBalance(c, b.balanceId);
          const m = await getMaterial(c, bal.materialId);
          const code = await placeCode(c, bal.containerId, bal.locationId);
          const mv = await createMovement(c, { type: 'COUNT', userId: request.user!.id, reason: b.reason ?? null });
          let message: string;
          let remaining: number | null = null;
          if (m.tracking === 'NOT_TRACKED') {
            const present = b.present ?? true;
            await applyLine(c, mv, 1, { material: m, lotId: bal.lotId, containerId: bal.containerId, locationId: bal.locationId, delta: null, presence: present, counted: true });
            message = present ? `Comprobado: hay ${m.description} en ${code}` : `Anotado: ya no hay ${m.description} en ${code}`;
          } else {
            if (b.counted === undefined) throw badRequest('Indica cuánto has contado');
            if (b.counted > 0) checkQuantity(m, b.counted, 'Lo contado');
            const diff = b.counted - bal.quantity!;
            if (b.counted < bal.quantity! && b.counted < bal.quantity! - bal.free!) {
              throw conflict('Lo contado es menos de lo asignado a proyectos. Revisa las asignaciones antes', 'STOCK_ASIGNADO');
            }
            remaining = await applyLine(c, mv, 1, { material: m, lotId: bal.lotId, containerId: bal.containerId, locationId: bal.locationId, delta: diff, counted: true });
            message = diff === 0
              ? `Recuento correcto: ${fmt(b.counted, m.unitCode)} en ${code}`
              : `Recuento anotado en ${code}: el sistema decía ${fmt(bal.quantity, m.unitCode)}, hay ${fmt(b.counted, m.unitCode)} (${diff > 0 ? '+' : ''}${fmt(diff, m.unitCode)})`;
          }
          await audit(c, request, 'stock.recuento', mv.id, { movimiento: mv.number, material: m.internalRef, sitio: code, esperado: bal.quantity, contado: b.counted ?? b.present });
          return { movementNumber: mv.number, remaining, message };
        });
      }),
  );

  // ---- Reverso ------------------------------------------------------------
  // Deshace un movimiento con otro de signo contrario. El original no se toca.
  app.post(
    '/api/stock/movements/:id/reverse',
    {
      preHandler: requirePermission('stock.reverse'),
      schema: {
        params: idParams,
        body: { type: 'object', required: ['reason'], additionalProperties: false, properties: { reason: { type: 'string', minLength: 3, maxLength: 300 } } },
      },
    },
    (request, reply) =>
      idempotent(pool, request, reply, async (): Promise<OpResult> => {
        const { id } = request.params as { id: string };
        const { reason } = request.body as { reason: string };
        return withTransaction(pool, async (c) => {
          const orig = (await c.query(`SELECT * FROM stock_movement WHERE id = $1 FOR UPDATE`, [id])).rows[0];
          if (!orig) throw notFound('El movimiento no existe');
          if (!['RECEIPT', 'WITHDRAWAL', 'RETURN', 'TRANSFER', 'COUNT'].includes(orig.movement_type)) {
            throw conflict('Este tipo de movimiento no se puede revertir desde aquí', 'NO_REVERSIBLE');
          }
          const done = await c.query(`SELECT movement_number::int AS n FROM stock_movement WHERE reverses_movement_id = $1`, [id]);
          if (done.rowCount) throw conflict(`Ya se revirtió con el movimiento ${done.rows[0].n}`, 'YA_REVERTIDO');
          const lines = (await c.query(`SELECT * FROM stock_movement_line WHERE movement_id = $1 ORDER BY line_no`, [id])).rows;
          if (lines.some((l) => l.quantity_tracking === 'NOT_TRACKED')) {
            throw conflict('Los movimientos de material sin contar no se revierten: registra una entrada o retirada nueva', 'NO_REVERSIBLE');
          }
          const mv = await createMovement(c, { type: 'REVERSAL', userId: request.user!.id, reason, reversesId: id });
          // Primero lo que sale, luego lo que entra, para no dejar negativos intermedios.
          const ordered = [...lines].sort((a, b) => Number(b.quantity_delta) - Number(a.quantity_delta));
          let n = 1;
          for (const l of ordered) {
            const m = await getMaterial(c, l.material_id);
            if (l.container_id) await resolvePlace(c, { containerId: l.container_id });
            try {
              await applyLine(c, mv, n++, { material: m, lotId: l.lot_id, containerId: l.container_id, locationId: l.location_id, delta: -Number(l.quantity_delta) });
            } catch (e) {
              if (e instanceof AppError && e.code === 'STOCK_INSUFICIENTE') {
                throw conflict('No se puede revertir: ese material ya se ha movido o retirado después', 'NO_REVERSIBLE');
              }
              throw e;
            }
          }
          await audit(c, request, 'stock.reverso', mv.id, { movimiento: mv.number, revierte: orig.movement_number, motivo: reason });
          return { movementNumber: mv.number, remaining: null, message: `Movimiento ${orig.movement_number} revertido con el ${mv.number}` };
        });
      }),
  );

  // ---- Préstamos ----------------------------------------------------------
  app.get(
    '/api/loans',
    {
      preHandler: requirePermission('stock.read'),
      schema: { querystring: { type: 'object', additionalProperties: false, properties: { all: { type: 'boolean', default: false } } } },
    },
    async (request) => {
      const { all } = request.query as { all: boolean };
      const r = await pool.query(
        `${LOAN_SELECT} WHERE ($1 OR t.status = 'OPEN') ORDER BY (t.status = 'OPEN') DESC, t.due_at LIMIT 1000`,
        [all],
      );
      return { loans: r.rows };
    },
  );

  app.post(
    '/api/loans',
    {
      preHandler: requirePermission('loan.create'),
      schema: {
        body: {
          type: 'object', required: ['balanceId'], additionalProperties: false,
          properties: {
            balanceId: uuid, quantity: qty, dueDate: { type: 'string', format: 'date' }, borrowerId: uuid, notes: text(300),
          },
        },
      },
    },
    (request, reply) =>
      idempotent(pool, request, reply, async (): Promise<OpResult> => {
        const b = request.body as { balanceId: string; quantity?: number; dueDate?: string; borrowerId?: string; notes?: string };
        const borrowerId = b.borrowerId ?? request.user!.id;
        if (borrowerId !== request.user!.id && !request.user!.permissions.includes('loan.manage')) {
          throw forbidden('Solo un responsable puede prestar a otra persona');
        }
        const out = await withTransaction(pool, async (c) => {
          const bal = await lockBalance(c, b.balanceId);
          const m = await getMaterial(c, bal.materialId);
          if (!m.isLoanable) throw conflict(`${m.description} no está marcado como herramienta prestable`, 'NO_PRESTABLE');
          if (m.tracking === 'NOT_TRACKED') throw conflict('Para prestar algo hay que llevar su cantidad', 'NO_PRESTABLE');
          const borrower = await c.query(`SELECT full_name FROM app_user WHERE id = $1 AND active`, [borrowerId]);
          if (!borrower.rowCount) throw badRequest('La persona indicada no existe');
          const quantity = checkQuantity(m, b.quantity ?? 1)!;
          checkFree(bal, m, quantity);
          const code = await placeCode(c, bal.containerId, bal.locationId);
          if (quantity > bal.quantity!) throw conflict(`Solo hay ${fmt(bal.quantity, m.unitCode)} en ${code}`, 'STOCK_INSUFICIENTE');

          let due: Date;
          if (b.dueDate) {
            due = new Date(`${b.dueDate}T20:00:00`);
            if (due.getTime() <= Date.now()) throw badRequest('La fecha de devolución tiene que ser posterior a hoy');
          } else {
            const days = Number(await getParameter(c, 'loan.default_days', 14)) || 14;
            due = new Date();
            due.setDate(due.getDate() + days);
            due.setHours(20, 0, 0, 0);
          }

          const mv = await createMovement(c, { type: 'LOAN_OUT', userId: request.user!.id, reason: `Préstamo a ${borrower.rows[0].full_name}` });
          await applyLine(c, mv, 1, { material: m, lotId: bal.lotId, containerId: bal.containerId, locationId: bal.locationId, delta: -quantity });
          const loan = await c.query(
            `INSERT INTO tool_loan (material_id, lot_id, quantity, borrower_id, due_at, out_movement_id, notes, container_id, location_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
            [m.id, bal.lotId, quantity, borrowerId, due, mv.id, b.notes?.trim() || null, bal.containerId, bal.locationId],
          );
          await writeAudit(c, {
            userId: request.user!.id, action: 'prestamo.salida', entityType: 'tool_loan', entityId: loan.rows[0].id,
            after: { material: m.internalRef, cantidad: quantity, para: borrower.rows[0].full_name, devolver: due.toISOString(), movimiento: mv.number },
            ip: request.ip, requestId: request.id,
          });
          return {
            movementNumber: mv.number,
            remaining: bal.quantity! - quantity,
            message: `Prestado: ${fmt(quantity, m.unitCode)} de ${m.description} a ${borrower.rows[0].full_name}, hasta el ${due.toLocaleDateString('es-ES')}`,
          };
        });
        reply.code(201);
        return out;
      }),
  );

  app.post(
    '/api/loans/:id/return',
    {
      preHandler: requirePermission('loan.create'),
      schema: {
        params: idParams,
        body: {
          type: 'object', additionalProperties: false,
          properties: { toContainerId: uuid, toLocationId: uuid, notes: text(300) },
        },
      },
    },
    (request, reply) =>
      idempotent(pool, request, reply, async (): Promise<OpResult> => {
        const { id } = request.params as { id: string };
        const b = (request.body ?? {}) as { toContainerId?: string; toLocationId?: string; notes?: string };
        return withTransaction(pool, async (c) => {
          const loan = (await c.query(`SELECT * FROM tool_loan WHERE id = $1 FOR UPDATE`, [id])).rows[0];
          if (!loan) throw notFound('El préstamo no existe');
          if (loan.status !== 'OPEN') throw conflict('Este préstamo ya está cerrado', 'PRESTAMO_CERRADO');
          if (loan.borrower_id !== request.user!.id && !request.user!.permissions.includes('loan.manage')) {
            throw forbidden('Solo quien lo tiene o un responsable puede devolverlo');
          }
          const m = await getMaterial(c, loan.material_id);
          const target = b.toContainerId || b.toLocationId
            ? { containerId: b.toContainerId, locationId: b.toLocationId }
            : { containerId: loan.container_id, locationId: loan.location_id };
          const place = await resolvePlace(c, target);
          const mv = await createMovement(c, { type: 'LOAN_RETURN', userId: request.user!.id, reason: b.notes ?? 'Devolución de préstamo' });
          await applyLine(c, mv, 1, { material: m, lotId: loan.lot_id, containerId: place.containerId, locationId: place.locationId, delta: Number(loan.quantity) });
          await c.query(
            `UPDATE tool_loan SET status = 'RETURNED', returned_at = now(), return_movement_id = $2,
                    notes = CASE WHEN $3::text IS NULL THEN notes ELSE concat_ws(' · ', notes, $3) END
              WHERE id = $1`,
            [id, mv.id, b.notes?.trim() || null],
          );
          await writeAudit(c, {
            userId: request.user!.id, action: 'prestamo.devolucion', entityType: 'tool_loan', entityId: id,
            after: { material: m.internalRef, a: place.code, movimiento: mv.number }, ip: request.ip, requestId: request.id,
          });
          return { movementNumber: mv.number, remaining: null, message: `Devuelto: ${m.description} a ${place.code}` };
        });
      }),
  );
}
