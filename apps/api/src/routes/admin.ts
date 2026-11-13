import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { writeAudit } from '../audit.js';
import { requirePermission } from '../auth/guard.js';
import { hashPassword, passwordProblem } from '../auth/password.js';
import { revokeUserSessions } from '../auth/sessions.js';
import { withTransaction } from '../db/tx.js';
import { badRequest, conflict, forbidden, notFound } from '../errors.js';

const USERNAME_PATTERN = '^[a-z0-9][a-z0-9._-]{2,49}$';

const USER_SELECT = `
  SELECT u.id, u.username, u.full_name AS "fullName", u.email, u.active,
         u.must_change_password AS "mustChangePassword",
         u.last_login_at AS "lastLoginAt", u.created_at AS "createdAt",
         (u.locked_until IS NOT NULL AND u.locked_until > now()) AS locked,
         coalesce(array_agg(r.code ORDER BY r.code) FILTER (WHERE r.code IS NOT NULL), '{}') AS roles
    FROM app_user u
    LEFT JOIN user_role ur ON ur.user_id = u.id
    LEFT JOIN role r ON r.id = ur.role_id`;

async function getUser(db: pg.Pool | pg.PoolClient, id: string) {
  const r = await db.query(`${USER_SELECT} WHERE u.id = $1 GROUP BY u.id`, [id]);
  return r.rows[0];
}

async function setRoles(c: pg.PoolClient, userId: string, roleCodes: string[]) {
  const unique = [...new Set(roleCodes)];
  const roles = await c.query(`SELECT id, code FROM role WHERE code = ANY($1)`, [unique]);
  if (roles.rowCount !== unique.length) throw badRequest('Alguno de los roles indicados no existe', 'ROL_NO_EXISTE');
  await c.query(`DELETE FROM user_role WHERE user_id = $1`, [userId]);
  for (const role of roles.rows) {
    await c.query(`INSERT INTO user_role (user_id, role_id) VALUES ($1, $2)`, [userId, role.id]);
  }
}

/** El sistema no puede quedarse sin ningún administrador técnico activo. */
async function assertAdminRemains(c: pg.PoolClient) {
  const r = await c.query(
    `SELECT count(*)::int AS n FROM app_user u
       JOIN user_role ur ON ur.user_id = u.id JOIN role r ON r.id = ur.role_id
      WHERE r.code = 'ADMIN_TECNICO' AND u.active`,
  );
  if (r.rows[0].n === 0) {
    throw conflict('Debe quedar al menos un administrador técnico activo', 'ULTIMO_ADMINISTRADOR');
  }
}

const idParams = {
  type: 'object',
  required: ['id'],
  properties: { id: { type: 'string', format: 'uuid' } },
} as const;

export function adminRoutes(app: FastifyInstance, deps: { pool: pg.Pool }) {
  const { pool } = deps;

  app.get('/api/admin/roles', { preHandler: requirePermission('admin.users.manage') }, async () => {
    const r = await pool.query(
      `SELECT r.code, r.name, r.description,
              coalesce(array_agg(p.code ORDER BY p.code) FILTER (WHERE p.code IS NOT NULL), '{}') AS permissions
         FROM role r
         LEFT JOIN role_permission rp ON rp.role_id = r.id
         LEFT JOIN permission p ON p.id = rp.permission_id
        GROUP BY r.id ORDER BY r.name`,
    );
    return { roles: r.rows };
  });

  app.get('/api/admin/users', { preHandler: requirePermission('admin.users.manage') }, async () => {
    const r = await pool.query(`${USER_SELECT} GROUP BY u.id ORDER BY u.full_name`);
    return { users: r.rows };
  });

  app.post(
    '/api/admin/users',
    {
      preHandler: requirePermission('admin.users.manage', 'admin.roles.manage'),
      schema: {
        body: {
          type: 'object',
          required: ['username', 'fullName', 'password', 'roles'],
          additionalProperties: false,
          properties: {
            username: { type: 'string', pattern: USERNAME_PATTERN },
            fullName: { type: 'string', minLength: 1, maxLength: 150 },
            email: { type: 'string', maxLength: 200 },
            password: { type: 'string', minLength: 1, maxLength: 200 },
            roles: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string' } },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { username: string; fullName: string; email?: string; password: string; roles: string[] };
      const problem = passwordProblem(body.password);
      if (problem) throw badRequest(problem, 'CONTRASENA_DEBIL');
      const passwordHash = await hashPassword(body.password);

      const user = await withTransaction(pool, async (c) => {
        const exists = await c.query(`SELECT 1 FROM app_user WHERE username = $1`, [body.username]);
        if (exists.rowCount) throw conflict('Ya existe un usuario con ese nombre', 'USUARIO_DUPLICADO');

        // La contraseña la pone el administrador: el usuario debe cambiarla al entrar.
        const created = await c.query(
          `INSERT INTO app_user (username, full_name, email, password_hash, must_change_password)
           VALUES ($1, $2, $3, $4, true) RETURNING id`,
          [body.username, body.fullName.trim(), body.email?.trim() || null, passwordHash],
        );
        const id = created.rows[0].id as string;
        await setRoles(c, id, body.roles);
        const result = await getUser(c, id);
        await writeAudit(c, {
          userId: request.user!.id, action: 'usuario.alta', entityType: 'app_user', entityId: id,
          after: { username: result.username, fullName: result.fullName, roles: result.roles },
          ip: request.ip, requestId: request.id,
        });
        return result;
      });

      reply.code(201);
      return { user };
    },
  );

  app.patch(
    '/api/admin/users/:id',
    {
      preHandler: requirePermission('admin.users.manage'),
      schema: {
        params: idParams,
        body: {
          type: 'object',
          additionalProperties: false,
          minProperties: 1,
          properties: {
            fullName: { type: 'string', minLength: 1, maxLength: 150 },
            email: { type: 'string', maxLength: 200 },
            active: { type: 'boolean' },
            roles: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'string' } },
          },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const body = request.body as { fullName?: string; email?: string; active?: boolean; roles?: string[] };
      const me = request.user!;

      if (body.roles && !me.permissions.includes('admin.roles.manage')) throw forbidden();
      if (id === me.id && body.active === false) {
        throw conflict('No puedes desactivar tu propio usuario', 'AUTODESACTIVACION');
      }

      const user = await withTransaction(pool, async (c) => {
        const before = await getUser(c, id);
        if (!before) throw notFound('El usuario no existe');

        await c.query(
          `UPDATE app_user
              SET full_name = coalesce($2, full_name),
                  email = CASE WHEN $3::text IS NULL THEN email ELSE nullif($3, '') END,
                  active = coalesce($4, active),
                  updated_at = now()
            WHERE id = $1`,
          [id, body.fullName?.trim() ?? null, body.email?.trim() ?? null, body.active ?? null],
        );
        if (body.roles) await setRoles(c, id, body.roles);
        await assertAdminRemains(c);

        // Al desactivar un usuario se cierran sus sesiones. Los cambios de rol se
        // aplican en la siguiente petición: los permisos se leen de la base de datos cada vez.
        if (body.active === false) await revokeUserSessions(c, id);

        const after = await getUser(c, id);
        await writeAudit(c, {
          userId: me.id, action: 'usuario.modificacion', entityType: 'app_user', entityId: id,
          before: { fullName: before.fullName, email: before.email, active: before.active, roles: before.roles },
          after: { fullName: after.fullName, email: after.email, active: after.active, roles: after.roles },
          ip: request.ip, requestId: request.id,
        });
        return after;
      });

      return { user };
    },
  );

  app.post(
    '/api/admin/users/:id/reset-password',
    {
      preHandler: requirePermission('admin.users.manage'),
      schema: {
        params: idParams,
        body: {
          type: 'object',
          required: ['newPassword'],
          additionalProperties: false,
          properties: { newPassword: { type: 'string', minLength: 1, maxLength: 200 } },
        },
      },
    },
    async (request) => {
      const { id } = request.params as { id: string };
      const { newPassword } = request.body as { newPassword: string };
      const problem = passwordProblem(newPassword);
      if (problem) throw badRequest(problem, 'CONTRASENA_DEBIL');
      const newHash = await hashPassword(newPassword);

      await withTransaction(pool, async (c) => {
        const r = await c.query(
          `UPDATE app_user
              SET password_hash = $2, must_change_password = true, failed_login_count = 0,
                  locked_until = NULL, updated_at = now()
            WHERE id = $1`,
          [id, newHash],
        );
        if (!r.rowCount) throw notFound('El usuario no existe');
        await revokeUserSessions(c, id);
        await writeAudit(c, {
          userId: request.user!.id, action: 'usuario.restablecer_contrasena', entityType: 'app_user', entityId: id,
          ip: request.ip, requestId: request.id,
        });
      });
      return { ok: true };
    },
  );

  app.get(
    '/api/admin/audit',
    {
      preHandler: requirePermission('audit.read'),
      schema: {
        querystring: {
          type: 'object',
          additionalProperties: false,
          properties: {
            limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
            before: { type: 'integer', minimum: 1 },
          },
        },
      },
    },
    async (request) => {
      const q = request.query as { limit: number; before?: number };
      const r = await pool.query(
        `SELECT a.id::int, a.occurred_at AS "occurredAt", a.action, a.entity_type AS "entityType",
                a.entity_id AS "entityId", a.before_data AS "before", a.after_data AS "after",
                u.username, u.full_name AS "fullName"
           FROM audit_log a LEFT JOIN app_user u ON u.id = a.user_id
          WHERE ($2::bigint IS NULL OR a.id < $2)
          ORDER BY a.id DESC LIMIT $1`,
        [q.limit, q.before ?? null],
      );
      return { entries: r.rows };
    },
  );
}
