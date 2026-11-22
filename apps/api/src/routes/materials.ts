import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { writeAudit } from '../audit.js';
import { requirePermission } from '../auth/guard.js';
import { withTransaction } from '../db/tx.js';
import { AppError, badRequest, conflict, notFound } from '../errors.js';
import { applyLine, copyUnit, createMovement, getMaterial, withdrawAll } from '../inventory/stock.js';

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
         f.content_type_code AS "contentTypeCode",
         tree.path, tree.ids AS "ancestorIds",
         (SELECT count(*)::int FROM material m WHERE m.family_id = f.id AND m.deleted_at IS NULL) AS "materialCount",
         (SELECT count(*)::int FROM material_family k WHERE k.parent_id = f.id) AS "childCount"
    FROM material_family f JOIN tree ON tree.id = f.id`;

export const MATERIAL_SELECT = `
  SELECT m.id, m.internal_ref AS "internalRef", m.description, m.family_id AS "familyId", f.name AS "familyName",
         m.manufacturer, m.manufacturer_ref AS "manufacturerRef", m.material_spec AS "materialSpec",
         m.quality_grade AS "qualityGrade", m.dimensions, m.unit_code AS "unitCode", u.decimals,
         m.quantity_tracking AS "quantityTracking", m.lot_tracked AS "lotTracked", m.is_loanable AS "isLoanable",
         m.min_stock::float AS "minStock", m.notes, m.status, m.created_at AS "createdAt", m.deleted_at AS "deletedAt",
         m.content_type_code AS "contentTypeCode", ct.name AS "contentTypeName",
         ct.unit_tracked AS "unitTracked", m.serial_number AS "serialNumber", m.qr_token AS "qrToken",
         (SELECT ph.id FROM photo ph WHERE ph.entity_type = 'material' AND ph.entity_id = m.id ORDER BY ph.position LIMIT 1) AS "photoId",
         s.quantity::float AS quantity, s.quantity_free::float AS "quantityFree", s.places::int AS places,
         coalesce(s.needs_recount, false) AS "needsRecount",
         (m.min_stock IS NOT NULL AND m.quantity_tracking <> 'NOT_TRACKED' AND coalesce(s.quantity, 0) < m.min_stock) AS "lowStock",
         (SELECT coalesce(sum(t.quantity), 0)::float FROM tool_loan t WHERE t.material_id = m.id AND t.status = 'OPEN') AS "onLoan",
         (SELECT json_build_object('borrowerName', lu.full_name, 'projectCode', lp.code, 'projectName', lp.name,
                                   'dueAt', t.due_at, 'overdue', t.due_at < now())
            FROM tool_loan t JOIN app_user lu ON lu.id = t.borrower_id LEFT JOIN project lp ON lp.id = t.project_id
           WHERE t.material_id = m.id AND t.status = 'OPEN' ORDER BY t.due_at LIMIT 1) AS "openLoan"
    FROM material m
    JOIN content_type ct ON ct.code = m.content_type_code
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
  serialNumber: nullableText(80),
  status: { type: 'string', enum: ['ACTIVE', 'OBSOLETE'] },
  contentTypeCode: { type: 'string', maxLength: 30 },
} as const;

type MaterialInput = Partial<{
  description: string; familyId: string; internalRef: string; manufacturer: string | null; manufacturerRef: string | null;
  materialSpec: string | null; qualityGrade: string | null; dimensions: string | null; unitCode: string;
  quantityTracking: string; lotTracked: boolean; isLoanable: boolean; minStock: number | null; notes: string | null; status: string;
  contentTypeCode: string; serialNumber: string | null;
}>;

/** Tipo de contenido activo, o error. */
export async function contentType(c: pg.PoolClient, code: string | undefined): Promise<{ code: string; prefix: string; unitTracked: boolean; name: string }> {
  const r = await c.query(`SELECT code, code_prefix AS prefix, active, unit_tracked AS "unitTracked", name FROM content_type WHERE code = $1`, [code ?? 'MATERIAL']);
  if (!r.rows[0]) throw badRequest('El tipo de contenido no existe', 'TIPO_NO_EXISTE');
  if (!r.rows[0].active) throw conflict('Ese tipo de contenido está desactivado', 'TIPO_INACTIVO');
  return r.rows[0];
}

/** Siguiente código automático: prefijo del tipo y número de una única secuencia (MAT-000012, HER-000013...). */
export const AUTO_REF = (prefixParam: string) => `${prefixParam} || '-' || lpad(nextval('material_ref_seq')::text, 6, '0')`;

const typeCodeFrom = (name: string) =>
  name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'TIPO';

/** Un tipo recién creado aún no tiene familias: mientras tanto vale cualquiera. */
const hasFamilies = async (c: pg.PoolClient, type: string) =>
  Boolean((await c.query(`SELECT 1 FROM material_family WHERE content_type_code = $1 AND active LIMIT 1`, [type])).rowCount);

const familyMismatch = (fam: { name: string }, type: { name: string }) =>
  badRequest(`Esa familia es de ${fam.name}; para ${type.name} elige una familia de ${type.name}`, 'FAMILIA_DE_OTRO_TIPO');

const clean = (v: string | null | undefined) => (v === undefined ? undefined : v === null ? null : v.trim() || null);

export function materialRoutes(app: FastifyInstance, deps: { pool: pg.Pool }) {
  const { pool } = deps;

  app.get('/api/units', { preHandler: requirePermission('material.read') }, async () => {
    const r = await pool.query(`SELECT code, name, decimals FROM unit_of_measure ORDER BY name`);
    return { units: r.rows };
  });

  // ---- Tipos de contenido -------------------------------------------------
  app.get('/api/content-types', { preHandler: requirePermission('material.read') }, async () => {
    const r = await pool.query(
      `SELECT t.code, t.name, t.code_prefix AS "codePrefix", t.default_tracking AS "defaultTracking",
              t.default_loanable AS "defaultLoanable", t.unit_tracked AS "unitTracked", t.active, t.sort_order AS "sortOrder",
              (SELECT count(*)::int FROM material m WHERE m.content_type_code = t.code AND m.deleted_at IS NULL) AS "contentCount"
         FROM content_type t ORDER BY t.sort_order, t.name`,
    );
    return { types: r.rows };
  });

  const typeProps = {
    name: { type: 'string', minLength: 1, maxLength: 60 },
    codePrefix: { type: 'string', pattern: '^[A-Za-z]{2,5}$' },
    defaultTracking: { type: 'string', enum: ['EXACT', 'ESTIMATED', 'NOT_TRACKED'] },
    defaultLoanable: { type: 'boolean' },
    unitTracked: { type: 'boolean' },
    active: { type: 'boolean' },
  } as const;

  /** Un prefijo no puede coincidir con el de otro tipo de contenido ni con uno de contenedor. */
  async function prefixFree(c: pg.PoolClient, prefix: string, exceptCode: string | null) {
    const r = await c.query(
      `SELECT 1 FROM content_type WHERE code_prefix = $1 AND code IS DISTINCT FROM $2
       UNION ALL SELECT 1 FROM container_type WHERE code_prefix = $1`,
      [prefix, exceptCode],
    );
    if (r.rowCount) throw conflict(`El prefijo ${prefix} ya lo usa otro tipo`, 'TIPO_DUPLICADO');
  }

  app.post(
    '/api/content-types',
    {
      preHandler: requirePermission('admin.masterdata.manage'),
      schema: { body: { type: 'object', required: ['name', 'codePrefix'], additionalProperties: false, properties: typeProps } },
    },
    async (request, reply) => {
      const b = request.body as { name: string; codePrefix: string; defaultTracking?: string; defaultLoanable?: boolean; unitTracked?: boolean };
      const prefix = b.codePrefix.toUpperCase();
      const code = await withTransaction(pool, async (c) => {
        await prefixFree(c, prefix, null);
        let code = typeCodeFrom(b.name);
        for (let i = 2; (await c.query(`SELECT 1 FROM content_type WHERE code = $1`, [code])).rowCount; i++) code = `${typeCodeFrom(b.name).slice(0, 27)}_${i}`;
        const dup = await c.query(`SELECT 1 FROM content_type WHERE lower(name) = lower($1)`, [b.name.trim()]);
        if (dup.rowCount) throw conflict(`Ya existe el tipo «${b.name.trim()}»`, 'TIPO_DUPLICADO');
        await c.query(
          `INSERT INTO content_type (code, name, code_prefix, default_tracking, default_loanable, unit_tracked, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, (SELECT coalesce(max(sort_order), 0) + 1 FROM content_type))`,
          [code, b.name.trim(), prefix, b.unitTracked ? 'EXACT' : (b.defaultTracking ?? 'EXACT'), b.defaultLoanable ?? false, b.unitTracked ?? false],
        );
        await writeAudit(c, {
          userId: request.user!.id, action: 'tipo_contenido.alta', entityType: 'content_type', entityId: code,
          after: { ...b, codePrefix: prefix }, ip: request.ip, requestId: request.id,
        });
        return code;
      });
      reply.code(201);
      return { code };
    },
  );

  app.patch(
    '/api/content-types/:code',
    {
      preHandler: requirePermission('admin.masterdata.manage'),
      schema: {
        params: { type: 'object', required: ['code'], properties: { code: { type: 'string', maxLength: 30 } } },
        body: { type: 'object', additionalProperties: false, minProperties: 1, properties: typeProps },
      },
    },
    async (request) => {
      const { code } = request.params as { code: string };
      const b = request.body as { name?: string; codePrefix?: string; defaultTracking?: string; defaultLoanable?: boolean; unitTracked?: boolean; active?: boolean };
      return withTransaction(pool, async (c) => {
        const before = (await c.query(`SELECT * FROM content_type WHERE code = $1 FOR UPDATE`, [code])).rows[0];
        if (!before) throw notFound('El tipo de contenido no existe');
        if (b.active === false && code === 'MATERIAL') throw conflict('El tipo «Material» no se puede desactivar: es el de por defecto', 'TIPO_BASE');
        let recoded = 0;
        const prefix = b.codePrefix?.toUpperCase();
        if (prefix && prefix !== before.code_prefix) {
          await prefixFree(c, prefix, code);
          // Los códigos automáticos de este tipo cambian de prefijo; los puestos a mano se respetan.
          const clash = await c.query(
            `SELECT m.internal_ref FROM material m
              WHERE m.content_type_code = $1 AND m.internal_ref ~ ('^' || $2 || '-[0-9]{6}$')
                AND EXISTS (SELECT 1 FROM material x WHERE x.internal_ref = $3 || substr(m.internal_ref, length($2) + 1))
              LIMIT 1`,
            [code, before.code_prefix, prefix],
          );
          if (clash.rowCount) throw conflict(`No se puede: ${clash.rows[0].internal_ref} chocaría con un código que ya existe`, 'CODIGO_DUPLICADO');
          const r = await c.query(
            `UPDATE material SET internal_ref = $3 || substr(internal_ref, length($2) + 1), updated_at = now()
              WHERE content_type_code = $1 AND internal_ref ~ ('^' || $2 || '-[0-9]{6}$')`,
            [code, before.code_prefix, prefix],
          );
          recoded = r.rowCount ?? 0;
        }
        if (b.name && b.name.trim().toLowerCase() !== before.name.toLowerCase()) {
          const dup = await c.query(`SELECT 1 FROM content_type WHERE lower(name) = lower($1) AND code <> $2`, [b.name.trim(), code]);
          if (dup.rowCount) throw conflict(`Ya existe el tipo «${b.name.trim()}»`, 'TIPO_DUPLICADO');
        }
        await c.query(
          `UPDATE content_type SET name = coalesce($2, name), code_prefix = coalesce($3, code_prefix),
                  default_tracking = coalesce($4, default_tracking), default_loanable = coalesce($5, default_loanable),
                  active = coalesce($6, active), unit_tracked = coalesce($7, unit_tracked)
            WHERE code = $1`,
          [code, b.name?.trim() ?? null, prefix ?? null, b.defaultTracking ?? null, b.defaultLoanable ?? null, b.active ?? null, b.unitTracked ?? null],
        );
        await writeAudit(c, {
          userId: request.user!.id, action: 'tipo_contenido.modificacion', entityType: 'content_type', entityId: code,
          before: { nombre: before.name, prefijo: before.code_prefix }, after: { ...b, recodificados: recoded }, ip: request.ip, requestId: request.id,
        });
        return { recoded };
      });
    },
  );

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
          properties: {
            name: { type: 'string', minLength: 1, maxLength: 80 }, parentId: uuid, defaultUnitCode: { type: 'string', maxLength: 10 },
            contentTypeCode: { type: 'string', maxLength: 40 },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { name: string; parentId?: string; defaultUnitCode?: string; contentTypeCode?: string };
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
        // Una familia de primer nivel dice de qué tipo de contenido es; una subfamilia lo hereda.
        let type = body.contentTypeCode ?? null;
        if (!body.parentId) {
          type ??= (await c.query(`SELECT code FROM content_type ORDER BY sort_order, name LIMIT 1`)).rows[0]?.code ?? null;
          if (!type || !(await c.query(`SELECT 1 FROM content_type WHERE code = $1`, [type])).rowCount) {
            throw badRequest('Elige de qué tipo de contenido es la familia', 'TIPO_NO_VALIDO');
          }
        }
        const r = await c.query(
          `INSERT INTO material_family (code, name, parent_id, default_unit_code, content_type_code) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [code, name, body.parentId ?? null, body.defaultUnitCode ?? null, type ?? 'MATERIAL'],
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
            contentTypeCode: { type: 'string', maxLength: 40 },
          },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = request.body as { name?: string; parentId?: string | null; defaultUnitCode?: string | null; active?: boolean; contentTypeCode?: string };
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
                  active = coalesce($6, active),
                  content_type_code = coalesce($7, content_type_code)
            WHERE id = $1`,
          [id, name, parentId, 'defaultUnitCode' in body, body.defaultUnitCode ?? null, body.active ?? null, body.contentTypeCode ?? null],
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
      const f = (await c.query(`SELECT name, parent_id, content_type_code FROM material_family WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!f) throw notFound('La familia no existe');
      const used = (await c.query(
        `SELECT (SELECT count(*) FROM material WHERE family_id = $1 AND deleted_at IS NULL)::int AS m,
                (SELECT count(*) FROM material WHERE family_id = $1 AND deleted_at IS NOT NULL)::int AS gone,
                (SELECT count(*) FROM material_family WHERE parent_id = $1)::int AS k`,
        [id],
      )).rows[0];
      if (used.k) throw conflict(`«${f.name}» tiene subfamilias: bórralas o muévelas antes, o desactívala`, 'FAMILIA_EN_USO');
      if (used.m) throw conflict(`«${f.name}» tiene ${used.m} contenido${used.m === 1 ? '' : 's'}: muévelos a otra familia antes, o desactívala`, 'FAMILIA_EN_USO');
      if (used.gone) {
        // Solo quedan contenidos eliminados (ocultos, con su historial): pasan a la familia de arriba,
        // o a otra del mismo tipo, y siguen ocultos.
        const to = f.parent_id ?? (await c.query(
          `SELECT id FROM material_family WHERE id <> $1 ORDER BY (content_type_code = $2) DESC, (parent_id IS NULL) DESC, active DESC, name LIMIT 1`,
          [id, f.content_type_code],
        )).rows[0]?.id;
        if (!to) throw conflict(`«${f.name}» es la única familia y aún la usan contenidos eliminados con historial`, 'FAMILIA_EN_USO');
        await c.query(`UPDATE material SET family_id = $2 WHERE family_id = $1 AND deleted_at IS NOT NULL`, [id, to]);
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
          WHERE m.deleted_at IS NULL AND (m.status = 'ACTIVE' OR $1) AND ($2::boolean IS NULL OR m.is_loanable = $2)
          ORDER BY m.description LIMIT 5000`,
        [q.includeObsolete, q.loanable ?? null],
      );
      return { materials: r.rows };
    },
  );

  // ---- Separar en unidades ------------------------------------------------
  // Para contenidos de un tipo por unidad que ya tenían varias unidades con el
  // mismo código (de antes de este cambio): deja una en el contenido y crea un
  // contenido nuevo por cada una de las demás, en el mismo sitio.
  app.post('/api/materials/:id/split-units', { preHandler: requirePermission('material.manage'), schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return withTransaction(pool, async (c) => {
      const m = await getMaterial(c, id);
      if (!m.unitTracked) throw badRequest('Solo se separan los contenidos de un tipo por unidad', 'NO_ES_POR_UNIDAD');
      const balances = (await c.query(
        `SELECT id, quantity::float AS q, container_id, location_id, lot_id FROM stock_balance WHERE material_id = $1 ORDER BY created_at, id FOR UPDATE`,
        [id],
      )).rows as Array<{ id: string; q: number | null; container_id: string | null; location_id: string | null; lot_id: string | null }>;
      const onLoan = Number((await c.query(`SELECT coalesce(sum(quantity), 0) AS n FROM tool_loan WHERE material_id = $1 AND status = 'OPEN'`, [id])).rows[0].n);
      let keep = onLoan > 0 ? 0 : 1;
      const created: Array<{ id: string; internalRef: string }> = [];
      let mv: { id: string; number: number } | null = null;
      let line = 1;
      for (const b of balances) {
        for (let k = 0; k < Math.floor(b.q ?? 1); k++) {
          if (keep > 0) { keep--; continue; }
          mv ??= await createMovement(c, { type: 'ADJUSTMENT', userId: request.user!.id, reason: `Separación en unidades de ${m.internalRef}` });
          const u = await copyUnit(c, m, request.user!.id);
          await applyLine(c, mv, line++, { material: m, lotId: b.lot_id, containerId: b.container_id, locationId: b.location_id, delta: -1, presence: true });
          await applyLine(c, mv, line++, { material: u, lotId: null, containerId: b.container_id, locationId: b.location_id, delta: 1, presence: true });
          created.push({ id: u.id, internalRef: u.internalRef });
        }
      }
      if (!created.length) throw badRequest('Ya es una sola unidad', 'YA_ES_UNIDAD');
      await writeAudit(c, {
        userId: request.user!.id, action: 'material.separacion', entityType: 'material', entityId: id,
        after: { ref: m.internalRef, unidades_nuevas: created.map((x) => x.internalRef) }, ip: request.ip, requestId: request.id,
      });
      return { units: created };
    });
  });

  // Eliminar: solo el administrador técnico. Sin historial se borra del todo;
  // con historial desaparece de todas partes, pero su historial se conserva.
  app.delete('/api/materials/:id', { preHandler: requirePermission('material.delete'), schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    return withTransaction(pool, async (c) => {
      const m = (await c.query(`SELECT internal_ref, description, deleted_at FROM material WHERE id = $1 FOR UPDATE`, [id])).rows[0];
      if (!m || m.deleted_at) throw notFound('El contenido no existe');
      // Lo prestado está fuera del almacén: primero tiene que volver.
      const loans = (await c.query(`SELECT count(*)::int AS n FROM tool_loan WHERE material_id = $1 AND returned_at IS NULL`, [id])).rows[0].n;
      if (loans) throw conflict(`No se puede eliminar ${m.internal_ref}: está prestado. Que lo devuelvan antes`, 'CONTENIDO_PRESTADO');

      // Lo que aún esté guardado se saca de su sitio con una retirada, que queda en el historial.
      const balances = (await c.query(`SELECT id FROM stock_balance WHERE material_id = $1`, [id])).rows.map((r) => r.id as string);
      const out = await withdrawAll(c, request.user!.id, balances, `Contenido eliminado: ${m.internal_ref}`);

      // Saldos a cero que queden (estimados) no son historial.
      await c.query(`DELETE FROM stock_allocation WHERE stock_balance_id IN (SELECT id FROM stock_balance WHERE material_id = $1)`, [id]);
      await c.query(`DELETE FROM stock_balance WHERE material_id = $1`, [id]);
      let how: 'borrado' | 'oculto' = 'borrado';
      await c.query('SAVEPOINT borrar');
      try {
        // Los comentarios no se borran nunca (son historial): si tiene, se conserva oculto.
        const notes = (await c.query(`SELECT 1 FROM note WHERE entity_type = 'material' AND entity_id = $1 LIMIT 1`, [id])).rowCount;
        if (notes) throw Object.assign(new Error('tiene comentarios'), { code: '23503' });
        await c.query(`DELETE FROM photo WHERE entity_type = 'material' AND entity_id = $1`, [id]);
        await c.query(`DELETE FROM material WHERE id = $1`, [id]);
      } catch (e) {
        if ((e as { code?: string }).code !== '23503') throw e;
        await c.query('ROLLBACK TO SAVEPOINT borrar');
        await c.query(`UPDATE material SET deleted_at = now(), deleted_by = $2, status = 'OBSOLETE', updated_at = now() WHERE id = $1`, [id, request.user!.id]);
        how = 'oculto';
      }
      await writeAudit(c, {
        userId: request.user!.id, action: 'contenido.eliminar', entityType: 'material', entityId: id,
        before: { ref: m.internal_ref, descripcion: m.description }, after: { resultado: how === 'borrado' ? 'borrado del todo' : 'eliminado, con su historial conservado' },
        ip: request.ip, requestId: request.id,
      });
      return { ok: true, ref: m.internal_ref, keptHistory: how === 'oculto', withdrawn: out?.lines ?? 0 };
    });
  });

  app.get('/api/materials/:id', { preHandler: requirePermission('material.read'), schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const m = (await pool.query(`${MATERIAL_SELECT} WHERE m.id = $1`, [id])).rows[0];
    if (!m) throw notFound('El contenido no existe');
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
          type: 'object', required: ['description', 'familyId'], additionalProperties: false,
          properties: materialBody,
        },
      },
    },
    async (request, reply) => {
      const body = request.body as MaterialInput;
      const id = await withTransaction(pool, async (c) => {
        await checkRefs(c, body);
        if (body.internalRef) await refCheck(c, body.internalRef, null);
        // El tipo es el de la familia (las familias cuelgan de un tipo de contenido).
        const famType = (await c.query(`SELECT content_type_code FROM material_family WHERE id = $1`, [body.familyId])).rows[0].content_type_code as string;
        const type = await contentType(c, body.contentTypeCode ?? famType);
        if (type.code !== famType && await hasFamilies(c, type.code)) throw familyMismatch(await contentType(c, famType), type);
        // Herramientas y equipos van de uno en uno: su unidad es siempre «ud».
        const unitCode = type.unitTracked ? 'ud' : body.unitCode;
        if (!unitCode) throw badRequest('Indica la unidad', 'FALTA_UNIDAD');
        const r = await c.query(
          `INSERT INTO material
             (internal_ref, description, family_id, manufacturer, manufacturer_ref, material_spec, quality_grade,
              dimensions, unit_code, quantity_tracking, lot_tracked, is_loanable, min_stock, notes, content_type_code, serial_number)
           VALUES (coalesce($1, ${AUTO_REF('$16::text')}),
                   $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $17)
           RETURNING id, internal_ref`,
          [
            body.internalRef?.trim().toUpperCase() || null, body.description!.trim(), body.familyId,
            clean(body.manufacturer) ?? null, clean(body.manufacturerRef) ?? null, clean(body.materialSpec) ?? null,
            clean(body.qualityGrade) ?? null, clean(body.dimensions) ?? null, unitCode,
            body.quantityTracking ?? 'EXACT', body.lotTracked ?? false, body.isLoanable ?? false,
            body.minStock ?? null, clean(body.notes) ?? null, type.code, type.prefix, clean(body.serialNumber) ?? null,
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
      if (new Set(items.map((i) => i.id)).size !== items.length) throw badRequest('Un contenido aparece dos veces');
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
  if (!before) throw notFound('El contenido no existe');
  await checkRefs(c, body);
  if (body.internalRef) await refCheck(c, body.internalRef, id);

  // Familia y tipo van juntos: al cambiar de familia, el tipo sigue a la familia;
  // al cambiar de tipo, la familia tiene que ser de ese tipo.
  if (body.familyId !== undefined || body.contentTypeCode !== undefined) {
    const famType = (await c.query(`SELECT content_type_code FROM material_family WHERE id = $1`, [body.familyId ?? before.family_id])).rows[0].content_type_code as string;
    const finalType = body.contentTypeCode ?? (body.familyId !== undefined ? famType : before.content_type_code);
    if (finalType !== famType && await hasFamilies(c, finalType)) throw familyMismatch(await contentType(c, famType), await contentType(c, finalType));
    if (finalType !== before.content_type_code) body = { ...body, contentTypeCode: finalType };
  }

  // Cambiar cómo se cuenta o la unidad de un material que ya tiene stock cambiaría el sentido de lo guardado.
  const hasStock = (await c.query(`SELECT 1 FROM stock_balance WHERE material_id = $1 LIMIT 1`, [id])).rowCount;
  if (hasStock && body.unitCode && body.unitCode !== before.unit_code) {
    throw conflict('No se puede cambiar la unidad de un contenido que tiene stock', 'MATERIAL_CON_STOCK');
  }
  if (hasStock && body.quantityTracking && body.quantityTracking !== before.quantity_tracking
      && (body.quantityTracking === 'NOT_TRACKED' || before.quantity_tracking === 'NOT_TRACKED')) {
    throw conflict('Para pasar de «sin contar» a contado, o al revés, el contenido no puede tener stock', 'MATERIAL_CON_STOCK');
  }
  if (body.lotTracked && !before.lot_tracked) {
    const noLot = await c.query(`SELECT 1 FROM stock_balance WHERE material_id = $1 AND lot_id IS NULL LIMIT 1`, [id]);
    if (noLot.rowCount) throw conflict('Hay stock de este contenido sin lote. Para exigir lote, primero tiene que estar todo con lote', 'MATERIAL_CON_STOCK');
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
  if (body.serialNumber !== undefined) col('serial_number', clean(body.serialNumber));
  if (body.status !== undefined) col('status', body.status);
  // Cambiar de tipo cambia el prefijo del código, si era automático (MAT-000012 → HER-000012).
  if (body.contentTypeCode !== undefined && body.contentTypeCode !== before.content_type_code) {
    const to = await contentType(c, body.contentTypeCode);
    col('content_type_code', to.code);
    const from = (await c.query(`SELECT code_prefix FROM content_type WHERE code = $1`, [before.content_type_code])).rows[0].code_prefix as string;
    const auto = new RegExp(`^${from}-(\\d{6})$`).exec(before.internal_ref);
    if (auto && body.internalRef === undefined) {
      const ref = `${to.prefix}-${auto[1]}`;
      await refCheck(c, ref, id);
      col('internal_ref', ref);
    }
  }
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
  if (r.rowCount) throw conflict(`Ya existe un contenido con la referencia ${ref.trim().toUpperCase()}`, 'REFERENCIA_DUPLICADA');
}

/** Saldo de stock con el sitio, el lote y cuánto está restringido o asignado. */
export const BALANCE_SELECT = `
  SELECT b.id, b.material_id AS "materialId", m.internal_ref AS "internalRef", m.description, m.unit_code AS "unitCode",
         (SELECT ph.id FROM photo ph WHERE ph.entity_type = 'material' AND ph.entity_id = m.id ORDER BY ph.position LIMIT 1) AS "photoId",
         m.quantity_tracking AS "quantityTracking", m.is_loanable AS "isLoanable", u.decimals,
         (SELECT ct.unit_tracked FROM content_type ct WHERE ct.code = m.content_type_code) AS "unitTracked",
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
         lt.lot_code AS "lotCode", t.project_id AS "projectId", lp.code AS "projectCode", lp.name AS "projectName"
    FROM tool_loan t
    JOIN material m ON m.id = t.material_id
    JOIN app_user u ON u.id = t.borrower_id
    LEFT JOIN project lp ON lp.id = t.project_id
    LEFT JOIN material_lot lt ON lt.id = t.lot_id
    LEFT JOIN container k ON k.id = t.container_id
    LEFT JOIN storage_location sl ON sl.id = t.location_id`;
