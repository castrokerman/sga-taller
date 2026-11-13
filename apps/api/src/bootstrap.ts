import type pg from 'pg';
import { writeAudit } from './audit.js';
import { hashPassword, passwordProblem } from './auth/password.js';
import type { Config } from './config.js';
import { withTransaction } from './db/tx.js';

/**
 * Crea el primer administrador si la base de datos no tiene ningún usuario.
 * Las credenciales vienen del fichero .env y deben cambiarse al entrar.
 */
export async function ensureFirstAdmin(pool: pg.Pool, config: Config): Promise<'creado' | 'ya_habia_usuarios' | 'sin_configurar'> {
  const count = await pool.query(`SELECT count(*)::int AS n FROM app_user`);
  if (count.rows[0].n > 0) return 'ya_habia_usuarios';
  if (!config.adminUsername || !config.adminPassword) return 'sin_configurar';

  const problem = passwordProblem(config.adminPassword);
  if (problem) throw new Error(`ADMIN_PASSWORD no es válida: ${problem}`);
  const passwordHash = await hashPassword(config.adminPassword);

  await withTransaction(pool, async (c) => {
    const u = await c.query(
      `INSERT INTO app_user (username, full_name, password_hash, must_change_password)
       VALUES ($1, 'Administrador', $2, true) RETURNING id`,
      [config.adminUsername!.toLowerCase(), passwordHash],
    );
    await c.query(`INSERT INTO user_role (user_id, role_id) SELECT $1, id FROM role WHERE code = 'ADMIN_TECNICO'`, [
      u.rows[0].id,
    ]);
    await writeAudit(c, { action: 'sistema.primer_administrador', entityType: 'app_user', entityId: u.rows[0].id });
  });
  return 'creado';
}

/** Usuarios ficticios para probar el piloto. Todos se llaman "FICTICIO ..." y usan la misma contraseña. */
export const DEMO_PASSWORD = 'demo-ficticio-2026';
const DEMO_USERS: Array<[username: string, fullName: string, role: string]> = [
  ['demo.almacen', 'FICTICIO Responsable de Almacén', 'RESP_ALMACEN'],
  ['demo.proyecto', 'FICTICIO Responsable de Proyecto', 'RESP_PROYECTO'],
  ['demo.usuario', 'FICTICIO Usuario Estándar', 'USUARIO'],
  ['demo.consulta', 'FICTICIO Usuario de Consulta', 'CONSULTA'],
];

export async function seedDemoUsers(pool: pg.Pool): Promise<number> {
  const passwordHash = await hashPassword(DEMO_PASSWORD);
  let created = 0;
  await withTransaction(pool, async (c) => {
    for (const [username, fullName, role] of DEMO_USERS) {
      const r = await c.query(
        `INSERT INTO app_user (username, full_name, password_hash)
         VALUES ($1, $2, $3) ON CONFLICT (username) DO NOTHING RETURNING id`,
        [username, fullName, passwordHash],
      );
      if (r.rowCount) {
        await c.query(`INSERT INTO user_role (user_id, role_id) SELECT $1, id FROM role WHERE code = $2`, [
          r.rows[0].id, role,
        ]);
        created++;
      }
    }
    if (created) await writeAudit(c, { action: 'sistema.usuarios_de_demostracion', after: { creados: created } });
  });
  return created;
}
