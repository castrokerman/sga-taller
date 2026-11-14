import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { writeAudit } from '../audit.js';
import { requirePermission } from '../auth/guard.js';
import { withTransaction } from '../db/tx.js';
import { AppError, badRequest, conflict, notFound } from '../errors.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;
const nullableText = (max: number) => ({ anyOf: [{ type: 'null' }, { type: 'string', maxLength: max }] });

// Gestionar familias: responsables de almacén (material.manage) y administradores.
const FAMILY_MANAGE = 'material.manage';

export const FAMILY_SELECT = `
  WITH RECURSIVE tree AS (
    SELECT id, name::text AS path, ARRAY[id] AS ids FROM material_family WHERE parent_id IS NULL
    UNION ALL
    SELECT f.id, tree.path || ' › ' || f.name, tree.ids || f.id FROM material_family f JOIN tree ON f.parent_id = tree.id
  )
  SELECT f.id, f.code, f.name, f.parent_id AS "parentId", f.default_unit_code AS "defaultUnitCode", f.active,
         tree.path, tree.ids AS "ancestorIds",
         (SELECT count(*)::int FROM material m WHERE m.family_id = f.id) AS "materialCount",
         (SELECT count(*)::int FROM material_family k WHERE k.parent_id = f.id) AS "childCount"
    FROM material_family f JOIN tree ON tree.id = f.id`;

export const MATERIAL_SELECT = `
  SELECT m.id, m.internal_ref AS "internalRef", m.description, m.family_id AS "familyId", f.name AS "familyName",
         m.manufacturer, m.manufacturer_ref AS "manufacturerRef", m.material_spec AS "materialSpec",
         m.quality_grade AS "qualityGrade", m.dimensions, m.unit_code AS "unitCode", u.decimals,
         m.quantity_tracking AS "quantityTracking", m.lot_tracked AS "lotTracked", m.is_loanable AS "isLoanable",
         m.min_stock::float AS "minStock", m.notes, m.status, m.created_at AS "createdAt",
         s.quantity::float AS quantity, s.quantity_free::float AS "quantityFree", s.places::int AS places,
         coalesce(s.needs_recount, false) AS "needsRecount",
         (m.min_stock IS NOT NULL AND m.quantity_tracking <> 'NOT_TRACKED' AND coalesce(s.quantity, 0) < m.min_stock) AS "lowStock",
         (SELECT coalesce(sum(t.quantity), 0)::float FROM tool_loan t WHERE t.material_id = m.id AND t.status = 'OPEN') AS "onLoan"
    FROM material m
    JOIN material_family f ON f.id = m.family_id
    JOIN unit_of_measure u ON u.code = m.unit_code
    JOIN material_stock s ON s.material_id = m.id`;

/** Código interno de familia a partir del nombre: «Tornillos M6» → TORNILLOS_M6. */
function familyCode(name: string): string {
  const base = name
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '')
    .slice(0, 24) || 'FAMILIA';
  return base;
}

const materialBody = {
  description: { type: 'string', minLength: 1, maxLength: 300 },
  familyId: uuid,
  internalRef: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._/-]{1,39}$' },
  manufacturer: nullableText(120),
  manufacturerRef: nullableText(80),
  materialSpec: nullableText(80),
  qualityGrade: nullableText(80),
  dimensions: nullableText(120),
  unitCode: { type: 'string', maxLength: 10 },
  quantityTracking: { type: 'string', enum: ['EXACT', 'ESTIMATED', 'NOT_TRACKED'] },
  lotTracked: { type: 'boolean' },
  isLoanable: { type: 'boolean' },
  minStock: { anyOf: [{ type: 'null' }, { type: 'number', minimum: 0, maximum: 1e12 }] },
  notes: nullableText(1000),
  status: { type: 'string', enum: ['ACTIVE', 'OBSOLETE'] },
} as const;

type MaterialInput = Partial<{
  description: string; familyId: string; internalRef: string; manufacturer: string | null; manufacturerRef: string | null;
  materialSpec: string | null; qualityGrade: string | null; dimensions: string | null; unitCode: string;
  quantityTracking: string; lotTracked: boolean; isLoanable: boolean; minStock: number | null; notes: string | null; status: string;
}>;

const clean = (v: string | null | undefined) => (v === undefined ? undefined : v === null ? null : v.trim() || null);

export function materialRoutes(app: FastifyInstance, deps: { pool: pg.Pool }) {
  const { pool } = deps;

  app.get('/api/units', { preHandler: requirePermission('material.read') }, async () => {
    const r = await pool.query(`SELECT code, name, decimals FROM unit_of_measure ORDER BY name`);
    return { units: r.rows };
  });

  // ---- Familias -----------------------------------------------------------
  app.get('/api/material-families', { preHandler: requirePermission('material.read') }, async () => {
    const r = await pool.query(`${FAMILY_SELECT} ORDER BY tree.path`);
    return { families: r.rows };
  });

  app.post(
    '/api/material-families',
    {
      preHandler: requirePermission(FAMILY_MANAGE),
      schema: {
        body: {
          type: 'object', required: ['name'], additionalProperties: false,
          properties: { name: { type: 'string', minLength: 1, maxLength: 80 }, parentId: uuid, defaultUnitCode: { type: 'string', maxLength: 10 } },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { name: string; parentId?: string; defaultUnitCode?: string };
      const name = body.name.trim();
      if (!name) throw badRequest('Escribe un nombre');
      const id = await withTransaction(pool, async (c) => {
        if (body.parentId) {
          const p = await c.query(`SELECT active FROM material_family WHERE id = $1`, [body.parentId]);
          if (!p.rows[0]) throw badRequest('La familia superior no existe');
        }
        await sameNameCheck(c, name, body.parentId ?? null, null);
        let code = familyCode(name);
        for (let i = 2; (await c.query(`SELECT 1 FROM material_family WHERE code = $1`, [code])).rowCount; i++) {
          code = `${familyCode(name).slice(0, 21)}_${i}`;
        }
        const r = await c.query(
          `INSERT INTO material_family (code, name, parent_id, default_unit_code) VALUES ($1, $2, $3, $4) RETURNING id`,
          [code, name, body.parentId ?? null, body.defaultUnitCode ?? null],
        );
        await writeAudit(c, {
          userId: request.user!.id, action: 'familia.alta', entityType: 'material_family', entityId: r.rows[0].id,
          after: { name, parentId: body.parentId ?? null }, ip: request.ip, requestId: request.id,
        });
        return r.rows[0].id as string;
      });
      reply.code(201);
      return { family: (await pool.query(`${FAMILY_SELECT} WHERE f.id = $1`, [id])).rows[0] };
    },
  );

  app.patch(
    '/api/material-families/:id',
    {
      preHandler: requirePermission(FAMILY_MANAGE),
      schema: {
        params: idParams,
        body: {
          type: 'object', additionalProperties: false, minProperties: 1,
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 80 },
            parentId: { anyOf: [{ type: 'null' }, uuid] },
            defaultUnitCode: { anyOf: [{ type: 'null' }, { type: 'string', maxLength: 10 }] },
            active: { type: 'boolean' },
          },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = request.body as { name?: string; parentId?: string | null; defaultUnitCode?: string | null; active?: boolean };
      await withTransaction(pool, async (c) => {
        const before = (await c.query(`SELECT name, parent_id, default_unit_code, active FROM material_family WHERE id = $1 FOR UPDATE`, [id])).rows[0];
        if (!before) throw notFound('La familia no existe');
        const name = body.name?.trim() ?? before.name;
        const parentId = 'parentId' in body ? body.parentId ?? null : before.parent_id;
        if (parentId === id) throw conflict('Una familia no puede quedar dentro de sí misma', 'SG015');
        await sameNameCheck(c, name, parentId, id);
        await c.query(
          `UPDATE material_family SET name = $2, parent_id = $3,
                  default_unit_code = CASE WHEN $4 THEN $5 ELSE default_unit_code END,
                  active = coalesce($6, active)
            WHERE id = $1`,
          [id, name, parentId, 'defaultUnitCode' in body, body.defaultUnitCode ?? null, body.active ?? null],
        );
        await writeAudit(c, {
          userId: request.user!.id, action: 'familia.modificacion', entityType: 'material_family', entityId: id,
          before, after: body, ip: request.ip, requestId: request.id,
        });
      });
      return { family: (await pool.query(`${FAMILY_SELECT} WHERE f.id = $1`, [id])).rows[0] };
    },
  );

  // Solo se borra una familia vacía y sin subfamilias. Las demás se desactivan.
  app.delete('/api/material-families/:id', { preHandler: requirePermission(FAMILY_MANAGE), schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    await withTransaction(pool, async (c) => {
      const f = (await c.query(`SELECT name FROM material_family WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!f) throw notFound('La familia no existe');
      const used = await c.query(
        `SELECT (SELECT count(*) FROM material WHERE family_id = $1)::int AS m, (SELECT count(*) FROM material_family WHERE parent_id = $1)::int AS k`,
        [id],
      );
      if (used.rows[0].m || used.rows[0].k) {
        throw conflict('Esta familia tiene materiales o subfamilias. Desactívala en lugar de borrarla', 'FAMILIA_EN_USO');
      }
      await c.query(`DELETE FROM material_family WHERE id = $1`, [id]);
      await writeAudit(c, {
        userId: request.user!.id, action: 'familia.baja', entityType: 'material_family', entityId: id,
        before: f, ip: request.ip, requestId: request.id,
      });
    });
    return { ok: true };
  });

  // ---- Materiales ---------------------------------------------------------
  app.get(
    '/api/materials',
    {
      preHandler: requirePermission('material.read'),
      schema: {
        querystring: {
          type: 'object', additionalProperties: false,
          properties: { includeObsolete: { type: 'boolean', default: false }, loanable: { type: 'boolean' } },
        },
      },
    },
    async (request) => {
      const q = request.query as { includeObsolete: boolean; loanable?: boolean };
      const r = await pool.query(
        `${MATERIAL_SELECT}
          WHERE (m.status = 'ACTIVE' OR $1) AND ($2::boolean IS NULL OR m.is_loanable = $2)
          ORDER BY m.description LIMIT 5000`,
        [q.includeObsolete, q.loanable ?? null],
      );
      return { materials: r.rows };
    },
  );

  app.get('/api/materials/:id', { preHandler: requirePermission('material.read'), schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const m = (await pool.query(`${MATERIAL_SELECT} WHERE m.id = $1`, [id])).rows[0];
    if (!m) throw notFound('El material no existe');
    const canStock = request.user!.permissions.includes('stock.read');
    const [family, stock, movements, loans] = await Promise.all([
      pool.query(`${FAMILY_SELECT} WHERE f.id = $1`, [m.familyId]),
      canStock ? pool.query(`${BALANCE_SELECT} WHERE b.material_id = $1 ORDER BY place_code, l.lot_code`, [id]) : null,
      canStock ? pool.query(`${MOVEMENT_LINE_SELECT} WHERE ml.material_id = $1 ORDER BY mv.movement_number DESC, ml.line_no LIMIT 200`, [id]) : null,
      pool.query(`${LOAN_SELECT} WHERE t.material_id = $1 AND t.status = 'OPEN' ORDER BY t.due_at`, [id]),
    ]);
    return {
      material: m,
      familyPath: family.rows[0]?.path ?? m.familyName,
      stock: stock?.rows ?? [],
      movements: movements?.rows ?? [],
      loans: loans.rows,
    };
  });

  app.post(
    '/api/materials',
    {
      preHandler: requirePermission('material.manage'),
      schema: {
        body: {
          type: 'object', required: ['description', 'familyId', 'unitCode'], additionalProperties: false,
          properties: materialBody,
        },
      },
    },
    async (request, reply) => {
      const body = request.body as MaterialInput;
      const id = await withTransaction(pool, async (c) => {
        await checkRefs(c, body);
        if (body.internalRef) await refCheck(c, body.internalRef, null);
        const r = await c.query(
          `INSERT INTO material
             (internal_ref, description, family_id, manufacturer, manufacturer_ref, material_spec, quality_grade,
              dimensions, unit_code, quantity_tracking, lot_tracked, is_loanable, min_stock, notes)
           VALUES (coalesce($1, 'MAT-' || lpad(nextval('material_ref_seq')::text, 6, '0')),
                   $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           RETURNING id, internal_ref`,
          [
            body.internalRef?.trim().toUpperCase() || null, body.description!.trim(), body.familyId,
            clean(body.manufacturer) ?? null, clean(body.manufacturerRef) ?? null, clean(body.materialSpec) ?? null,
            clean(body.qualityGrade) ?? null, clean(body.dimensions) ?? null, body.unitCode,
            body.quantityTracking ?? 'EXACT', body.lotTracked ?? false, body.isLoanable ?? false,
            body.minStock ?? null, clean(body.notes) ?? null,
          ],
        );
        await writeAudit(c, {
          userId: request.user!.id, action: 'material.alta', entityType: 'material', entityId: r.rows[0].id,
          after: { ref: r.rows[0].internal_ref, ...body }, ip: request.ip, requestId: request.id,
        });
        return r.rows[0].id as string;
      });
      reply.code(201);
      return { material: (await pool.query(`${MATERIAL_SELECT} WHERE m.id = $1`, [id])).rows[0] };
    },
  );

  app.patch(
    '/api/materials/:id',
    {
      preHandler: requirePermission('material.manage'),
      schema: { params: idParams, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: materialBody } },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      await withTransaction(pool, (c) => updateMaterial(c, request, id, request.body as MaterialInput));
      return { material: (await pool.query(`${MATERIAL_SELECT} WHERE m.id = $1`, [id])).rows[0] };
    },
  );

  // Edición de varios a la vez: todo o nada; si una fila falla, se dice cuál.
  app.patch(
    '/api/materials/bulk',
    {
      preHandler: requirePermission('material.manage'),
      schema: {
        body: {
          type: 'object', required: ['items'], additionalProperties: false,
          properties: {
            items: {
              type: 'array', minItems: 1, maxItems: 1000,
              items: { type: 'object', required: ['id'], additionalProperties: false, minProperties: 2, properties: { id: uuid, ...materialBody } },
            },
          },
        },
      },
    },
    async (request) => {
      const { items } = request.body as { items: Array<MaterialInput & { id: string }> };
      if (new Set(items.map((i) => i.id)).size !== items.length) throw badRequest('Un material aparece dos veces');
      await withTransaction(pool, async (c) => {
        for (const { id, ...changes } of items) {
          try {
            await updateMaterial(c, request, id, changes);
          } catch (e) {
            const ref = (await c.query(`SELECT internal_ref FROM material WHERE id = $1`, [id]).catch(() => null))?.rows[0]?.internal_ref;
            if (e instanceof AppError) throw new AppError(e.statusCode, e.code, `${ref ?? 'Un material'}: ${e.message}`);
            throw e;
          }
        }
      });
      const r = await pool.query(`${MATERIAL_SELECT} WHERE m.id = ANY($1)`, [items.map((i) => i.id)]);
      return { materials: r.rows };
    },
  );
}

async function updateMaterial(c: pg.PoolClient, request: FastifyRequest, id: string, body: MaterialInput) {
  const before = (await c.query(`SELECT * FROM material WHERE id = $1 FOR UPDATE`, [id])).rows[0];
  if (!before) throw notFound('El material no existe');
  await checkRefs(c, body);
  if (body.internalRef) await refCheck(c, body.internalRef, id);

  // Cambiar cómo se cuenta o la unidad de un material que ya tiene stock cambiaría el sentido de lo guardado.
  const hasStock = (await c.query(`SELECT 1 FROM stock_balance WHERE material_id = $1 LIMIT 1`, [id])).rowCount;
  if (hasStock && body.unitCode && body.unitCode !== before.unit_code) {
    throw conflict('No se puede cambiar la unidad de un material que tiene stock', 'MATERIAL_CON_STOCK');
  }
  if (hasStock && body.quantityTracking && body.quantityTracking !== before.quantity_tracking
      && (body.quantityTracking === 'NOT_TRACKED' || before.quantity_tracking === 'NOT_TRACKED')) {
    throw conflict('Para pasar de «sin contar» a contado, o al revés, el material no puede tener stock', 'MATERIAL_CON_STOCK');
  }
  if (body.lotTracked && !before.lot_tracked) {
    const noLot = await c.query(`SELECT 1 FROM stock_balance WHERE material_id = $1 AND lot_id IS NULL LIMIT 1`, [id]);
    if (noLot.rowCount) throw conflict('Hay stock de este material sin lote. Para exigir lote, primero tiene que estar todo con lote', 'MATERIAL_CON_STOCK');
  }

  const set: string[] = [];
  const values: unknown[] = [id];
  const col = (name: string, v: unknown) => {
    values.push(v);
    set.push(`${name} = $${values.length}`);
  };
  if (body.description !== undefined) col('description', body.description.trim());
  if (body.familyId !== undefined) col('family_id', body.familyId);
  if (body.internalRef !== undefined) col('internal_ref', body.internalRef.trim().toUpperCase());
  if (body.manufacturer !== undefined) col('manufacturer', clean(body.manufacturer));
  if (body.manufacturerRef !== undefined) col('manufacturer_ref', clean(body.manufacturerRef));
  if (body.materialSpec !== undefined) col('material_spec', clean(body.materialSpec));
  if (body.qualityGrade !== undefined) col('quality_grade', clean(body.qualityGrade));
  if (body.dimensions !== undefined) col('dimensions', clean(body.dimensions));
  if (body.unitCode !== undefined) col('unit_code', body.unitCode);
  if (body.quantityTracking !== undefined) col('quantity_tracking', body.quantityTracking);
  if (body.lotTracked !== undefined) col('lot_tracked', body.lotTracked);
  if (body.isLoanable !== undefined) col('is_loanable', body.isLoanable);
  if (body.minStock !== undefined) col('min_stock', body.minStock);
  if (body.notes !== undefined) col('notes', clean(body.notes));
  if (body.status !== undefined) col('status', body.status);
  await c.query(`UPDATE material SET ${set.join(', ')}, updated_at = now() WHERE id = $1`, values);
  await writeAudit(c, {
    userId: request.user!.id, action: 'material.modificacion', entityType: 'material', entityId: id,
    before: { ref: before.internal_ref, description: before.description }, after: body, ip: request.ip, requestId: request.id,
  });
}


async function sameNameCheck(c: pg.PoolClient, name: string, parentId: string | null, exceptId: string | null) {
  const r = await c.query(
    `SELECT 1 FROM material_family WHERE lower(name) = lower($1) AND parent_id IS NOT DISTINCT FROM $2 AND id IS DISTINCT FROM $3`,
    [name, parentId, exceptId],
  );
  if (r.rowCount) throw conflict(`Ya hay una familia «${name}» en ese nivel`, 'FAMILIA_DUPLICADA');
}

async function checkRefs(c: pg.PoolClient, body: MaterialInput) {
  if (body.familyId) {
    const f = await c.query(`SELECT active FROM material_family WHERE id = $1`, [body.familyId]);
    if (!f.rows[0]) throw badRequest('La familia no existe');
    if (!f.rows[0].active) throw conflict('Esa familia está desactivada', 'FAMILIA_INACTIVA');
  }
  if (body.unitCode) {
    const u = await c.query(`SELECT 1 FROM unit_of_measure WHERE code = $1`, [body.unitCode]);
    if (!u.rowCount) throw badRequest('La unidad no existe');
  }
}

async function refCheck(c: pg.PoolClient, ref: string, exceptId: string | null) {
  const r = await c.query(`SELECT 1 FROM material WHERE upper(internal_ref) = upper($1) AND id IS DISTINCT FROM $2`, [ref.trim(), exceptId]);
  if (r.rowCount) throw conflict(`Ya existe un material con la referencia ${ref.trim().toUpperCase()}`, 'REFERENCIA_DUPLICADA');
}

/** Saldo de stock con el sitio, el lote y cuánto está restringido o asignado. */
export const BALANCE_SELECT = `
  SELECT b.id, b.material_id AS "materialId", m.internal_ref AS "internalRef", m.description, m.unit_code AS "unitCode",
         m.quantity_tracking AS "quantityTracking", m.is_loanable AS "isLoanable", u.decimals,
         b.lot_id AS "lotId", l.lot_code AS "lotCode",
         b.container_id AS "containerId", b.location_id AS "locationId",
         coalesce(k.code, sl.code) AS "placeCode", coalesce(k.code, sl.code) AS place_code,
         el.code AS "locationCode",
         b.quantity::float AS quantity, a.quantity_free::float AS "quantityFree",
         a.quantity_restricted::float AS "quantityRestricted", a.quantity_project_free::float AS "quantityProjectFree",
         b.needs_recount AS "needsRecount", b.last_counted_at AS "lastCountedAt", b.updated_at AS "updatedAt",
         coalesce((SELECT json_agg(json_build_object(
                     'availability', sa.availability, 'quantity', sa.quantity::float,
                     'projectCode', p.code, 'projectName', p.name) ORDER BY p.code)
                     FROM stock_allocation sa LEFT JOIN project p ON p.id = sa.project_id
                    WHERE sa.stock_balance_id = b.id AND sa.quantity > 0), '[]') AS allocations
    FROM stock_balance b
    JOIN material m ON m.id = b.material_id
    JOIN unit_of_measure u ON u.code = m.unit_code
    JOIN stock_availability a ON a.stock_balance_id = b.id
    LEFT JOIN material_lot l ON l.id = b.lot_id
    LEFT JOIN container k ON k.id = b.container_id
    LEFT JOIN storage_location sl ON sl.id = b.location_id
    LEFT JOIN container_effective_location e ON e.container_id = b.container_id
    LEFT JOIN storage_location el ON el.id = coalesce(e.location_id, b.location_id)`;

/** Línea de movimiento de material, con quién, cuándo y dónde. */
export const MOVEMENT_LINE_SELECT = `
  SELECT mv.id AS "movementId", mv.movement_number::int AS "movementNumber", mv.movement_type AS "movementType",
         mv.performed_at AS "performedAt", u.full_name AS "performedBy", mv.reason,
         mv.external_reference AS "externalReference",
         rv.movement_number::int AS "reversesNumber",
         (SELECT r2.movement_number::int FROM stock_movement r2 WHERE r2.reverses_movement_id = mv.id) AS "reversedByNumber",
         ml.line_no AS "lineNo", ml.material_id AS "materialId", mt.internal_ref AS "internalRef", mt.description,
         mt.unit_code AS "unitCode", ml.quantity_tracking AS "quantityTracking",
         ml.quantity_delta::float AS "quantityDelta", ml.quantity_after::float AS "quantityAfter",
         lt.lot_code AS "lotCode", ml.container_id AS "containerId", ml.location_id AS "locationId",
         coalesce(k.code, sl.code) AS "placeCode"
    FROM stock_movement_line ml
    JOIN stock_movement mv ON mv.id = ml.movement_id
    JOIN app_user u ON u.id = mv.performed_by
    JOIN material mt ON mt.id = ml.material_id
    LEFT JOIN stock_movement rv ON rv.id = mv.reverses_movement_id
    LEFT JOIN material_lot lt ON lt.id = ml.lot_id
    LEFT JOIN container k ON k.id = ml.container_id
    LEFT JOIN storage_location sl ON sl.id = ml.location_id`;

export const LOAN_SELECT = `
  SELECT t.id, t.material_id AS "materialId", m.internal_ref AS "internalRef", m.description, m.unit_code AS "unitCode",
         t.quantity::float AS quantity, t.borrower_id AS "borrowerId", u.full_name AS "borrowerName",
         t.loaned_at AS "loanedAt", t.due_at AS "dueAt", t.returned_at AS "returnedAt", t.status, t.notes,
         (t.status = 'OPEN' AND t.due_at < now()) AS overdue,
         coalesce(k.code, sl.code) AS "fromCode", t.container_id AS "containerId", t.location_id AS "locationId",
         lt.lot_code AS "lotCode"
    FROM tool_loan t
    JOIN material m ON m.id = t.material_id
    JOIN app_user u ON u.id = t.borrower_id
    LEFT JOIN material_lot lt ON lt.id = t.lot_id
    LEFT JOIN container k ON k.id = t.container_id
    LEFT JOIN storage_location sl ON sl.id = t.location_id`;
