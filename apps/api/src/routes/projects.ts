import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { writeAudit } from '../audit.js';
import { requireAuth, requirePermission } from '../auth/guard.js';
import { withTransaction } from '../db/tx.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';
import { BALANCE_SELECT, LOAN_SELECT, MOVEMENT_LINE_SELECT } from './materials.js';

/**
 * Proyectos: los crean los responsables de almacén. Cada uno tiene uno o
 * varios responsables (que ven todo lo del proyecto y son los únicos que
 * pueden sacar lo reservado) y, si se quiere, miembros asociados.
 */

const uuid = { type: 'string', format: 'uuid' } as const;
const idParams = { type: 'object', required: ['id'], properties: { id: uuid } } as const;

const PROJECT_SELECT = `
  SELECT p.id, p.code, p.name, p.description, p.status, p.created_at AS "createdAt",
         coalesce((SELECT json_agg(json_build_object('id', u.id, 'fullName', u.full_name, 'active', u.active) ORDER BY pm.position, pm.created_at)
                     FROM project_member pm JOIN app_user u ON u.id = pm.user_id
                    WHERE pm.project_id = p.id AND pm.role = 'RESPONSIBLE'), '[]') AS responsibles,
         coalesce((SELECT json_agg(json_build_object('id', u.id, 'fullName', u.full_name, 'active', u.active) ORDER BY u.full_name)
                     FROM project_member pm JOIN app_user u ON u.id = pm.user_id
                    WHERE pm.project_id = p.id AND pm.role = 'MEMBER'), '[]') AS members,
         (SELECT count(*)::int FROM container k WHERE k.project_id = p.id AND k.status = 'ACTIVE') AS "containerCount",
         (SELECT count(*)::int FROM inbound_item i WHERE i.project_id = p.id AND i.status = 'PENDING') AS "pendingInbound"
    FROM project p`;

/** Contenedores del proyecto y los que hay dentro de ellos. */
const PROJECT_CONTAINERS = `
  WITH RECURSIVE pc AS (
    SELECT id FROM container WHERE project_id = $1
    UNION SELECT k.id FROM container k JOIN pc ON k.parent_container_id = pc.id
  )`;

type Role = 'RESPONSIBLE' | 'MEMBER' | null;

async function myRole(db: pg.Pool | pg.PoolClient, projectId: string, userId: string): Promise<Role> {
  const r = await db.query(`SELECT role FROM project_member WHERE project_id = $1 AND user_id = $2`, [projectId, userId]);
  return (r.rows[0]?.role as Role) ?? null;
}

const canManage = (request: FastifyRequest) => request.user!.permissions.includes('project.manage');

export function projectRoutes(app: FastifyInstance, deps: { pool: pg.Pool }) {
  const { pool } = deps;

  // ---- Lista --------------------------------------------------------------
  // Quien gestiona proyectos ve todos; los demás, aquellos en los que están.
  app.get(
    '/api/projects',
    {
      preHandler: requirePermission('project.read'),
      schema: { querystring: { type: 'object', additionalProperties: false, properties: { closed: { type: 'boolean', default: false } } } },
    },
    async (request) => {
      const { closed } = request.query as { closed: boolean };
      const all = canManage(request);
      const r = await pool.query(
        `${PROJECT_SELECT}
          WHERE ($1 OR p.status <> 'CLOSED')
            AND ($2 OR EXISTS (SELECT 1 FROM project_member pm WHERE pm.project_id = p.id AND pm.user_id = $3))
          ORDER BY (p.status = 'CLOSED'), p.code`,
        [closed, all, request.user!.id],
      );
      const roles = await pool.query(`SELECT project_id, role FROM project_member WHERE user_id = $1`, [request.user!.id]);
      const mine = new Map(roles.rows.map((x) => [x.project_id as string, x.role as Role]));
      return { projects: r.rows.map((p) => ({ ...p, myRole: mine.get(p.id) ?? null })), canManage: all };
    },
  );

  // Proyectos abiertos para elegir en una lista (recepciones, contenedores).
  app.get('/api/projects/options', { preHandler: requireAuth() }, async () => {
    const r = await pool.query(`SELECT id, code, name FROM project WHERE status = 'ACTIVE' ORDER BY code`);
    return { projects: r.rows };
  });

  // ---- Ficha --------------------------------------------------------------
  app.get('/api/projects/:id', { preHandler: requirePermission('project.read'), schema: { params: idParams } }, async (request) => {
    const { id } = request.params as { id: string };
    const r = await pool.query(`${PROJECT_SELECT} WHERE p.id = $1`, [id]);
    const project = r.rows[0];
    if (!project) throw notFound('El proyecto no existe');
    const role = await myRole(pool, id, request.user!.id);
    if (!canManage(request) && !role) throw forbidden('No estás en este proyecto');
    // Todo lo del proyecto solo lo ven sus responsables y quien gestiona proyectos.
    const full = canManage(request) || role === 'RESPONSIBLE';
    if (!full) return { project: { ...project, myRole: role }, full: false };
    const [containers, stock, inbound, loans, movements] = await Promise.all([
      pool.query(
        `SELECT c.id, c.code, c.description, t.name AS "typeName",
                coalesce(l.code, (SELECT code FROM storage_location WHERE id = e.location_id)) AS "locationCode",
                (SELECT count(*)::int FROM stock_balance b WHERE b.container_id = c.id) AS lines
           FROM container c JOIN container_type t ON t.id = c.container_type_id
           LEFT JOIN storage_location l ON l.id = c.location_id
           LEFT JOIN container_effective_location e ON e.container_id = c.id
          WHERE c.project_id = $1 AND c.status = 'ACTIVE' ORDER BY c.code`,
        [id],
      ),
      pool.query(`${PROJECT_CONTAINERS} ${BALANCE_SELECT} WHERE b.container_id IN (SELECT id FROM pc) ORDER BY m.description`, [id]),
      pool.query(
        `SELECT i.id, 'REC-' || lpad(i.number::text, 6, '0') AS code, i.status, i.description, i.received_at AS "receivedAt",
                m.description AS "materialDescription",
                (SELECT ph.id FROM photo ph WHERE ph.entity_type = 'inbound' AND ph.entity_id = i.id ORDER BY ph.position LIMIT 1) AS "photoId"
           FROM inbound_item i LEFT JOIN material m ON m.id = i.material_id
          WHERE i.project_id = $1 AND i.status <> 'CANCELLED' ORDER BY (i.status = 'PENDING') DESC, i.received_at DESC LIMIT 100`,
        [id],
      ),
      pool.query(`${PROJECT_CONTAINERS} ${LOAN_SELECT} WHERE t.status = 'OPEN' AND t.container_id IN (SELECT id FROM pc) ORDER BY t.due_at`, [id]),
      pool.query(
        `${PROJECT_CONTAINERS} ${MOVEMENT_LINE_SELECT}
          WHERE ml.container_id IN (SELECT id FROM pc)
             OR mv.id IN (SELECT receipt_movement_id FROM inbound_item WHERE project_id = $1 AND receipt_movement_id IS NOT NULL)
          ORDER BY mv.movement_number DESC, ml.line_no LIMIT 100`,
        [id],
      ),
    ]);
    return {
      project: { ...project, myRole: role },
      full: true,
      canEdit: canManage(request),
      containers: containers.rows,
      stock: stock.rows,
      inbound: inbound.rows,
      loans: loans.rows,
      movements: movements.rows,
    };
  });

  // ---- Alta y edición (responsables de almacén) ----------------------------
  const projectBody = {
    code: { type: 'string', minLength: 1, maxLength: 30, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' },
    name: { type: 'string', minLength: 1, maxLength: 150 },
    description: { type: 'string', maxLength: 1000 },
    status: { type: 'string', enum: ['ACTIVE', 'ON_HOLD', 'CLOSED'] },
    responsibleIds: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: uuid },
    memberIds: { type: 'array', maxItems: 200, uniqueItems: true, items: uuid },
  } as const;
  type Body = { code?: string; name?: string; description?: string; status?: string; responsibleIds?: string[]; memberIds?: string[] };

  async function setPeople(c: pg.PoolClient, projectId: string, responsibleIds: string[] | undefined, memberIds: string[] | undefined) {
    if (responsibleIds) {
      const ok = await c.query(`SELECT count(*)::int AS n FROM app_user WHERE id = ANY($1) AND active`, [responsibleIds]);
      if (ok.rows[0].n !== responsibleIds.length) throw badRequest('Alguno de los responsables no existe o está de baja', 'USUARIO_NO_EXISTE');
    }
    if (memberIds) {
      const ok = await c.query(`SELECT count(*)::int AS n FROM app_user WHERE id = ANY($1)`, [memberIds]);
      if (ok.rows[0].n !== memberIds.length) throw badRequest('Alguno de los miembros no existe', 'USUARIO_NO_EXISTE');
    }
    if (responsibleIds) {
      await c.query(`DELETE FROM project_member WHERE project_id = $1 AND role = 'RESPONSIBLE'`, [projectId]);
      for (const [i, u] of responsibleIds.entries()) {
        await c.query(
          `INSERT INTO project_member (project_id, user_id, role, position) VALUES ($1, $2, 'RESPONSIBLE', $3)
           ON CONFLICT (project_id, user_id) DO UPDATE SET role = 'RESPONSIBLE', position = $3`,
          [projectId, u, i],
        );
      }
      // El primero es el responsable principal (lo usarán las autorizaciones).
      await c.query(`UPDATE project SET responsible_user_id = $2, updated_at = now() WHERE id = $1`, [projectId, responsibleIds[0]]);
    }
    if (memberIds) {
      await c.query(`DELETE FROM project_member WHERE project_id = $1 AND role = 'MEMBER'`, [projectId]);
      const responsibles = (await c.query(`SELECT user_id FROM project_member WHERE project_id = $1 AND role = 'RESPONSIBLE'`, [projectId])).rows.map((x) => x.user_id);
      for (const u of memberIds.filter((x) => !responsibles.includes(x))) {
        await c.query(`INSERT INTO project_member (project_id, user_id, role) VALUES ($1, $2, 'MEMBER')`, [projectId, u]);
      }
    }
  }

  async function people(c: pg.PoolClient, id: string) {
    const r = await c.query(
      `SELECT pm.role, u.full_name FROM project_member pm JOIN app_user u ON u.id = pm.user_id WHERE pm.project_id = $1 ORDER BY pm.role DESC, pm.position, u.full_name`,
      [id],
    );
    return {
      responsables: r.rows.filter((x) => x.role === 'RESPONSIBLE').map((x) => x.full_name),
      miembros: r.rows.filter((x) => x.role === 'MEMBER').map((x) => x.full_name),
    };
  }

  app.post(
    '/api/projects',
    {
      preHandler: requirePermission('project.manage'),
      schema: { body: { type: 'object', required: ['code', 'name', 'responsibleIds'], additionalProperties: false, properties: projectBody } },
    },
    async (request, reply) => {
      const b = request.body as Required<Pick<Body, 'code' | 'name' | 'responsibleIds'>> & Body;
      const code = b.code.trim().toUpperCase();
      const id = await withTransaction(pool, async (c) => {
        if ((await c.query(`SELECT 1 FROM project WHERE code = $1`, [code])).rowCount) throw conflict(`Ya existe el proyecto ${code}`, 'PROYECTO_DUPLICADO');
        const r = await c.query(
          `INSERT INTO project (code, name, description, responsible_user_id, status) VALUES ($1, $2, $3, $4, coalesce($5, 'ACTIVE')) RETURNING id`,
          [code, b.name.trim(), b.description?.trim() || null, b.responsibleIds[0], b.status ?? null],
        );
        const id = r.rows[0].id as string;
        await setPeople(c, id, b.responsibleIds, b.memberIds ?? []);
        await writeAudit(c, {
          userId: request.user!.id, action: 'proyecto.alta', entityType: 'project', entityId: id,
          after: { codigo: code, nombre: b.name.trim(), ...(await people(c, id)) }, ip: request.ip, requestId: request.id,
        });
        return id;
      });
      reply.code(201);
      return { id, code };
    },
  );

  app.patch(
    '/api/projects/:id',
    {
      preHandler: requirePermission('project.manage'),
      schema: { params: idParams, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: projectBody } },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const b = request.body as Body;
      await withTransaction(pool, async (c) => {
        const before = (await c.query(`SELECT code, name, description, status FROM project WHERE id = $1 FOR UPDATE`, [id])).rows[0];
        if (!before) throw notFound('El proyecto no existe');
        const code = b.code?.trim().toUpperCase();
        if (code && code !== before.code && (await c.query(`SELECT 1 FROM project WHERE code = $1`, [code])).rowCount) {
          throw conflict(`Ya existe el proyecto ${code}`, 'PROYECTO_DUPLICADO');
        }
        const peopleBefore = await people(c, id);
        await c.query(
          `UPDATE project SET code = coalesce($2, code), name = coalesce($3, name),
                  description = CASE WHEN $4::text IS NULL THEN description ELSE nullif($4, '') END,
                  status = coalesce($5, status), updated_at = now()
            WHERE id = $1`,
          [id, code ?? null, b.name?.trim() ?? null, b.description?.trim() ?? null, b.status ?? null],
        );
        await setPeople(c, id, b.responsibleIds, b.memberIds);
        await writeAudit(c, {
          userId: request.user!.id, action: 'proyecto.modificacion', entityType: 'project', entityId: id,
          before: { ...before, ...peopleBefore }, after: { ...b, ...(await people(c, id)) }, ip: request.ip, requestId: request.id,
        });
      });
      const r = await pool.query(`${PROJECT_SELECT} WHERE p.id = $1`, [id]);
      return { project: r.rows[0] };
    },
  );

  // ---- Asignar un contenedor a un proyecto ---------------------------------
  // Lo hacen los responsables de almacén y los responsables del proyecto (del
  // que lo recibe y, si ya era de otro, también de ese).
  app.put(
    '/api/containers/:id/project',
    {
      preHandler: requirePermission('container.read'),
      schema: {
        params: idParams,
        body: { type: 'object', required: ['projectId'], additionalProperties: false, properties: { projectId: { anyOf: [{ type: 'null' }, uuid] } } },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const { projectId } = request.body as { projectId: string | null };
      return withTransaction(pool, async (c) => {
        const k = (await c.query(
          `SELECT c.code, c.project_id, p.code AS pcode FROM container c LEFT JOIN project p ON p.id = c.project_id WHERE c.id = $1 FOR UPDATE OF c`,
          [id],
        )).rows[0];
        if (!k) throw notFound('El contenedor no existe');
        if (k.project_id === projectId) return { ok: true };
        let to: { code: string; name: string } | null = null;
        if (projectId) {
          to = (await c.query(`SELECT code, name FROM project WHERE id = $1 AND status <> 'CLOSED'`, [projectId])).rows[0] ?? null;
          if (!to) throw badRequest('El proyecto no existe o está cerrado', 'PROYECTO_NO_VALIDO');
        }
        if (!canManage(request)) {
          const me = request.user!.id;
          const okTo = !projectId || (await myRole(c, projectId, me)) === 'RESPONSIBLE';
          const okFrom = !k.project_id || (await myRole(c, k.project_id, me)) === 'RESPONSIBLE';
          if (!okTo || !okFrom) throw forbidden('Solo los responsables de almacén o los responsables del proyecto pueden cambiarlo');
        }
        await c.query(`UPDATE container SET project_id = $2, updated_at = now() WHERE id = $1`, [id, projectId]);
        await writeAudit(c, {
          userId: request.user!.id, action: 'contenedor.proyecto', entityType: 'container', entityId: id,
          before: { contenedor: k.code, proyecto: k.pcode ?? null }, after: { proyecto: to?.code ?? null },
          ip: request.ip, requestId: request.id,
        });
        return { ok: true };
      });
    },
  );
}
