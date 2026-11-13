import { createHash, randomBytes } from 'node:crypto';
import type pg from 'pg';

export interface SessionUser {
  id: string;
  username: string;
  fullName: string;
  mustChangePassword: boolean;
  roles: string[];
  permissions: string[];
  sessionId: string;
}

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

async function sessionHours(db: pg.Pool | pg.PoolClient): Promise<number> {
  const r = await db.query<{ value: number }>(`SELECT value FROM system_parameter WHERE key = 'session.duration_hours'`);
  const hours = Number(r.rows[0]?.value);
  return Number.isFinite(hours) && hours > 0 ? hours : 12;
}

/** Crea una sesión y devuelve el token en claro, que solo conoce el navegador. */
export async function createSession(
  db: pg.Pool | pg.PoolClient,
  userId: string,
  meta: { ip?: string; userAgent?: string },
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const hours = await sessionHours(db);
  const r = await db.query<{ expires_at: Date }>(
    `INSERT INTO user_session (user_id, token_hash, expires_at, ip, user_agent)
     VALUES ($1, $2, now() + make_interval(hours => $3), $4, $5)
     RETURNING expires_at`,
    [userId, hashToken(token), hours, meta.ip ?? null, meta.userAgent?.slice(0, 500) ?? null],
  );
  return { token, expiresAt: r.rows[0]!.expires_at };
}

/** Devuelve el usuario de una sesión vigente, con sus roles y permisos, o null. */
export async function findSessionUser(db: pg.Pool, token: string): Promise<SessionUser | null> {
  const r = await db.query(
    `SELECT s.id AS session_id, u.id, u.username, u.full_name, u.must_change_password,
            coalesce(array_agg(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL), '{}') AS roles,
            coalesce(array_agg(DISTINCT p.code) FILTER (WHERE p.code IS NOT NULL), '{}') AS permissions
       FROM user_session s
       JOIN app_user u ON u.id = s.user_id
       LEFT JOIN user_role ur ON ur.user_id = u.id
       LEFT JOIN role r ON r.id = ur.role_id
       LEFT JOIN role_permission rp ON rp.role_id = r.id
       LEFT JOIN permission p ON p.id = rp.permission_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.active
      GROUP BY s.id, u.id`,
    [hashToken(token)],
  );
  const row = r.rows[0];
  if (!row) return null;

  // Marca de actividad, como mucho una vez por minuto.
  await db.query(
    `UPDATE user_session SET last_seen_at = now() WHERE id = $1 AND last_seen_at < now() - interval '1 minute'`,
    [row.session_id],
  );

  return {
    id: row.id,
    username: row.username,
    fullName: row.full_name,
    mustChangePassword: row.must_change_password,
    roles: row.roles,
    permissions: row.permissions,
    sessionId: row.session_id,
  };
}

export async function revokeSession(db: pg.Pool | pg.PoolClient, sessionId: string): Promise<void> {
  await db.query(`UPDATE user_session SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL`, [sessionId]);
}

/** Cierra todas las sesiones de un usuario (cambio de contraseña, desactivación...). */
export async function revokeUserSessions(db: pg.Pool | pg.PoolClient, userId: string, exceptSessionId?: string): Promise<void> {
  await db.query(
    `UPDATE user_session SET revoked_at = now()
      WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2::uuid)`,
    [userId, exceptSessionId ?? null],
  );
}
