import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { writeAudit } from '../audit.js';
import { publicUser, requireAuth } from '../auth/guard.js';
import { hashPassword, passwordProblem, verifyPassword } from '../auth/password.js';
import { createSession, findSessionUser, revokeSession, revokeUserSessions } from '../auth/sessions.js';
import type { Config } from '../config.js';
import { withTransaction } from '../db/tx.js';
import { AppError, badRequest } from '../errors.js';

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;
// Hash de relleno: si el usuario no existe se verifica igualmente, para que la
// respuesta tarde lo mismo y no revele qué usuarios existen.
const dummyHash = hashPassword('contraseña-de-relleno');

const invalidCredentials = () => new AppError(401, 'CREDENCIALES_NO_VALIDAS', 'Usuario o contraseña incorrectos');

export function authRoutes(app: FastifyInstance, deps: { pool: pg.Pool; config: Config }) {
  const { pool, config } = deps;

  const cookieOptions = (expires?: Date) => ({
    path: '/',
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'strict' as const,
    expires,
  });

  app.post(
    '/api/auth/login',
    {
      config: { rateLimit: { max: config.loginRateLimit, timeWindow: '1 minute' } },
      schema: {
        body: {
          type: 'object',
          required: ['username', 'password'],
          additionalProperties: false,
          properties: {
            username: { type: 'string', minLength: 1, maxLength: 100 },
            password: { type: 'string', minLength: 1, maxLength: 200 },
          },
        },
      },
    },
    async (request, reply) => {
      const body = request.body as { username: string; password: string };
      const username = body.username.trim().toLowerCase();
      const meta = { ip: request.ip, requestId: request.id };

      const found = await pool.query(
        `SELECT id, password_hash, active, locked_until > now() AS locked FROM app_user WHERE username = $1`,
        [username],
      );
      const user = found.rows[0];

      if (!user) {
        await verifyPassword(await dummyHash, body.password);
        await writeAudit(pool, { action: 'auth.login_fallido', entityType: 'app_user', entityId: username, ...meta });
        throw invalidCredentials();
      }

      if (user.locked) {
        await writeAudit(pool, { userId: user.id, action: 'auth.login_bloqueado', ...meta });
        throw new AppError(
          429,
          'CUENTA_BLOQUEADA',
          `Demasiados intentos fallidos. Espera ${LOCK_MINUTES} minutos o pide a un administrador que restablezca tu contraseña`,
        );
      }

      const ok = await verifyPassword(user.password_hash, body.password);

      if (!ok || !user.active) {
        if (!ok) {
          await pool.query(
            `UPDATE app_user
                SET failed_login_count = CASE WHEN failed_login_count + 1 >= $2 THEN 0 ELSE failed_login_count + 1 END,
                    locked_until = CASE WHEN failed_login_count + 1 >= $2
                                        THEN now() + make_interval(mins => $3) ELSE locked_until END
              WHERE id = $1`,
            [user.id, MAX_FAILED_LOGINS, LOCK_MINUTES],
          );
        }
        await writeAudit(pool, { userId: user.id, action: 'auth.login_fallido', ...meta });
        throw invalidCredentials();
      }

      const session = await withTransaction(pool, async (c) => {
        await c.query(
          `UPDATE app_user SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`,
          [user.id],
        );
        const s = await createSession(c, user.id, { ip: request.ip, userAgent: request.headers['user-agent'] });
        await writeAudit(c, { userId: user.id, action: 'auth.login', ...meta });
        return s;
      });

      reply.setCookie(config.cookieName, session.token, cookieOptions(session.expiresAt));
      const sessionUser = await findSessionUser(pool, session.token);
      return { user: publicUser(sessionUser!) };
    },
  );

  app.post('/api/auth/logout', { preHandler: requireAuth({ allowPasswordChangePending: true }) }, async (request, reply) => {
    await revokeSession(pool, request.user!.sessionId);
    await writeAudit(pool, { userId: request.user!.id, action: 'auth.logout', ip: request.ip, requestId: request.id });
    reply.clearCookie(config.cookieName, cookieOptions());
    return { ok: true };
  });

  app.get('/api/auth/me', { preHandler: requireAuth({ allowPasswordChangePending: true }) }, async (request) => ({
    user: publicUser(request.user!),
  }));

  app.post(
    '/api/auth/change-password',
    {
      preHandler: requireAuth({ allowPasswordChangePending: true }),
      schema: {
        body: {
          type: 'object',
          required: ['currentPassword', 'newPassword'],
          additionalProperties: false,
          properties: {
            currentPassword: { type: 'string', minLength: 1, maxLength: 200 },
            newPassword: { type: 'string', minLength: 1, maxLength: 200 },
          },
        },
      },
    },
    async (request) => {
      const body = request.body as { currentPassword: string; newPassword: string };
      const me = request.user!;

      const r = await pool.query(`SELECT password_hash FROM app_user WHERE id = $1`, [me.id]);
      if (!(await verifyPassword(r.rows[0].password_hash, body.currentPassword))) {
        throw badRequest('La contraseña actual no es correcta', 'CONTRASENA_ACTUAL_INCORRECTA');
      }
      const problem = passwordProblem(body.newPassword);
      if (problem) throw badRequest(problem, 'CONTRASENA_DEBIL');
      if (body.newPassword === body.currentPassword) {
        throw badRequest('La contraseña nueva debe ser distinta de la actual', 'CONTRASENA_REPETIDA');
      }

      const newHash = await hashPassword(body.newPassword);
      await withTransaction(pool, async (c) => {
        await c.query(
          `UPDATE app_user SET password_hash = $2, must_change_password = false, updated_at = now() WHERE id = $1`,
          [me.id, newHash],
        );
        await revokeUserSessions(c, me.id, me.sessionId); // cierra las demás sesiones
        await writeAudit(c, {
          userId: me.id, action: 'auth.cambio_contrasena', entityType: 'app_user', entityId: me.id,
          ip: request.ip, requestId: request.id,
        });
      });
      return { ok: true };
    },
  );
}
