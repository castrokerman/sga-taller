/**
 * Pruebas de la API de acceso: inicio de sesión, sesiones, permisos,
 * gestión de usuarios y auditoría. Datos ficticios sobre un PostgreSQL real.
 */
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { ensureFirstAdmin, seedDemoUsers, DEMO_PASSWORD } from '../src/bootstrap.js';
import type { Config } from '../src/config.js';
import { runMigrations } from '../src/db/migrate.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('Falta TEST_DATABASE_URL');

const ADMIN = { username: 'admin', password: 'ficticio-admin-0001' };
const config: Config = {
  databaseUrl: url,
  port: 0,
  host: '127.0.0.1',
  cookieSecure: true,
  cookieName: 'sga_session',
  adminUsername: ADMIN.username,
  adminPassword: ADMIN.password,
  seedDemo: true,
  logLevel: 'silent',
  loginRateLimit: 1000,
};

let pool: pg.Pool;
let app: FastifyInstance;

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await admin.end();
  await runMigrations(url);
  pool = new pg.Pool({ connectionString: url, max: 5 });
  app = await buildApp({ pool, config });
  expect(await ensureFirstAdmin(pool, config)).toBe('creado');
  expect(await seedDemoUsers(pool)).toBe(4);
  // El administrador de las pruebas ya ha cambiado su contraseña inicial.
  await pool.query(`UPDATE app_user SET must_change_password = false WHERE username = 'admin'`);
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

const HEADERS = { 'x-sga-client': 'web' };

async function login(username: string, password: string) {
  const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: HEADERS, payload: { username, password } });
  const setCookie = res.cookies.find((c) => c.name === 'sga_session');
  return { res, cookie: setCookie ? { sga_session: setCookie.value } : undefined, setCookie };
}

async function sessionOf(username: string, password = DEMO_PASSWORD) {
  const { res, cookie } = await login(username, password);
  expect(res.statusCode).toBe(200);
  return cookie!;
}

const call = (
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  cookies?: Record<string, string>,
  payload?: unknown,
  headers: Record<string, string> = HEADERS,
) => app.inject({ method, url: path, cookies, payload: payload as never, headers });

describe('inicio de sesión', () => {
  it('entra con credenciales correctas y devuelve una cookie segura', async () => {
    const { res, setCookie } = await login('demo.usuario', DEMO_PASSWORD);
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ username: 'demo.usuario', roles: ['USUARIO'] });
    expect(setCookie).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/' });
  });

  it('no distingue entre usuario inexistente y contraseña incorrecta', async () => {
    const a = (await login('demo.usuario', 'incorrecta')).res;
    const b = (await login('no.existe', 'incorrecta')).res;
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    expect(a.json()).toEqual(b.json());
    await pool.query(`UPDATE app_user SET failed_login_count = 0 WHERE username = 'demo.usuario'`);
  });

  it('acepta el nombre de usuario en mayúsculas', async () => {
    expect((await login('DEMO.Usuario', DEMO_PASSWORD)).res.statusCode).toBe(200);
  });

  it('nunca devuelve la contraseña ni su hash', async () => {
    const cookie = await sessionOf(ADMIN.username, ADMIN.password);
    const bodies = [
      (await login('demo.usuario', DEMO_PASSWORD)).res.body,
      (await call('GET', '/api/auth/me', cookie)).body,
      (await call('GET', '/api/admin/users', cookie)).body,
    ];
    for (const body of bodies) expect(body).not.toMatch(/argon2|password_hash|passwordHash/);
  });

  it('bloquea la cuenta tras cinco intentos fallidos', async () => {
    for (let i = 0; i < 5; i++) expect((await login('demo.consulta', 'incorrecta')).res.statusCode).toBe(401);
    const blocked = (await login('demo.consulta', DEMO_PASSWORD)).res;
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe('CUENTA_BLOQUEADA');
    // Pasado el bloqueo vuelve a entrar.
    await pool.query(`UPDATE app_user SET locked_until = now() - interval '1 second' WHERE username = 'demo.consulta'`);
    expect((await login('demo.consulta', DEMO_PASSWORD)).res.statusCode).toBe(200);
  });

  it('un usuario desactivado no puede entrar', async () => {
    await pool.query(`UPDATE app_user SET active = false WHERE username = 'demo.proyecto'`);
    expect((await login('demo.proyecto', DEMO_PASSWORD)).res.statusCode).toBe(401);
    await pool.query(`UPDATE app_user SET active = true, failed_login_count = 0 WHERE username = 'demo.proyecto'`);
  });
});

describe('sesiones', () => {
  it('sin sesión no se puede consultar nada', async () => {
    expect((await call('GET', '/api/auth/me')).statusCode).toBe(401);
    expect((await call('GET', '/api/auth/me', { sga_session: 'token-inventado' })).statusCode).toBe(401);
  });

  it('cerrar sesión invalida la cookie', async () => {
    const cookie = await sessionOf('demo.usuario');
    expect((await call('GET', '/api/auth/me', cookie)).statusCode).toBe(200);
    expect((await call('POST', '/api/auth/logout', cookie)).statusCode).toBe(200);
    expect((await call('GET', '/api/auth/me', cookie)).statusCode).toBe(401);
  });

  it('una sesión caducada deja de valer', async () => {
    const cookie = await sessionOf('demo.usuario');
    await pool.query(`UPDATE user_session SET expires_at = now() - interval '1 minute' WHERE revoked_at IS NULL
                       AND user_id = (SELECT id FROM app_user WHERE username = 'demo.usuario')`);
    expect((await call('GET', '/api/auth/me', cookie)).statusCode).toBe(401);
  });

  it('en la base de datos se guarda la huella del token, no el token', async () => {
    const cookie = await sessionOf('demo.usuario');
    const r = await pool.query(`SELECT 1 FROM user_session WHERE token_hash = $1`, [cookie.sga_session]);
    expect(r.rowCount).toBe(0);
  });

  it('rechaza las operaciones que no vienen de la web propia', async () => {
    const res = await call('POST', '/api/auth/login', undefined, { username: 'demo.usuario', password: DEMO_PASSWORD }, {});
    expect(res.statusCode).toBe(403);
  });
});

describe('permisos (escenario 17: acceso no autorizado a una función administrativa)', () => {
  it('sin sesión: 401', async () => {
    expect((await call('GET', '/api/admin/users')).statusCode).toBe(401);
  });

  it.each(['demo.usuario', 'demo.consulta', 'demo.proyecto', 'demo.almacen'])(
    '%s no puede gestionar usuarios: 403',
    async (username) => {
      const cookie = await sessionOf(username);
      expect((await call('GET', '/api/admin/users', cookie)).statusCode).toBe(403);
      const create = await call('POST', '/api/admin/users', cookie, {
        username: 'intruso', fullName: 'FICTICIO Intruso', password: 'ficticio-intruso-01', roles: ['ADMIN_TECNICO'],
      });
      expect(create.statusCode).toBe(403);
      expect((await pool.query(`SELECT 1 FROM app_user WHERE username = 'intruso'`)).rowCount).toBe(0);
    },
  );

  it('el responsable de almacén ve la auditoría; el usuario estándar no', async () => {
    expect((await call('GET', '/api/admin/audit', await sessionOf('demo.almacen'))).statusCode).toBe(200);
    expect((await call('GET', '/api/admin/audit', await sessionOf('demo.usuario'))).statusCode).toBe(403);
  });

  it('un cambio de rol se aplica en la siguiente petición, sin volver a entrar', async () => {
    const admin = await sessionOf(ADMIN.username, ADMIN.password);
    const cookie = await sessionOf('demo.usuario');
    const id = (await pool.query(`SELECT id FROM app_user WHERE username = 'demo.usuario'`)).rows[0].id;

    expect((await call('GET', '/api/admin/audit', cookie)).statusCode).toBe(403);
    expect((await call('PATCH', `/api/admin/users/${id}`, admin, { roles: ['RESP_ALMACEN'] })).statusCode).toBe(200);
    expect((await call('GET', '/api/admin/audit', cookie)).statusCode).toBe(200);
    expect((await call('PATCH', `/api/admin/users/${id}`, admin, { roles: ['USUARIO'] })).statusCode).toBe(200);
    expect((await call('GET', '/api/admin/audit', cookie)).statusCode).toBe(403);
  });
});

describe('gestión de usuarios', () => {
  it('el administrador crea un usuario, que debe cambiar la contraseña al entrar', async () => {
    const admin = await sessionOf(ADMIN.username, ADMIN.password);
    const created = await call('POST', '/api/admin/users', admin, {
      username: 'ficticio.nuevo', fullName: 'FICTICIO Nuevo', password: 'ficticio-inicial-01', roles: ['USUARIO'],
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().user).toMatchObject({ username: 'ficticio.nuevo', roles: ['USUARIO'], mustChangePassword: true });

    const cookie = await sessionOf('ficticio.nuevo', 'ficticio-inicial-01');
    // Hasta que no la cambie, no puede hacer nada más.
    const blocked = await call('GET', '/api/admin/users', cookie);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error.code).toBe('CAMBIO_DE_CONTRASENA');

    const weak = await call('POST', '/api/auth/change-password', cookie, {
      currentPassword: 'ficticio-inicial-01', newPassword: 'corta',
    });
    expect(weak.statusCode).toBe(400);
    const wrong = await call('POST', '/api/auth/change-password', cookie, {
      currentPassword: 'no-es-esta', newPassword: 'ficticio-definitiva-01',
    });
    expect(wrong.statusCode).toBe(400);
    const changed = await call('POST', '/api/auth/change-password', cookie, {
      currentPassword: 'ficticio-inicial-01', newPassword: 'ficticio-definitiva-01',
    });
    expect(changed.statusCode).toBe(200);

    expect((await call('GET', '/api/auth/me', cookie)).json().user.mustChangePassword).toBe(false);
    expect((await login('ficticio.nuevo', 'ficticio-inicial-01')).res.statusCode).toBe(401);
    expect((await login('ficticio.nuevo', 'ficticio-definitiva-01')).res.statusCode).toBe(200);
  });

  it('rechaza nombres duplicados, contraseñas débiles y roles inexistentes', async () => {
    const admin = await sessionOf(ADMIN.username, ADMIN.password);
    const base = { fullName: 'FICTICIO', password: 'ficticio-valida-0001', roles: ['USUARIO'] };
    expect((await call('POST', '/api/admin/users', admin, { ...base, username: 'demo.usuario' })).statusCode).toBe(409);
    expect((await call('POST', '/api/admin/users', admin, { ...base, username: 'ficticio.x1', password: 'corta' })).statusCode).toBe(400);
    expect((await call('POST', '/api/admin/users', admin, { ...base, username: 'ficticio.x2', roles: ['NO_EXISTE'] })).statusCode).toBe(400);
    expect((await call('POST', '/api/admin/users', admin, { ...base, username: 'Con Espacios' })).statusCode).toBe(400);
    expect((await pool.query(`SELECT 1 FROM app_user WHERE username LIKE 'ficticio.x%'`)).rowCount).toBe(0);
  });

  it('desactivar a un usuario cierra sus sesiones', async () => {
    const admin = await sessionOf(ADMIN.username, ADMIN.password);
    const cookie = await sessionOf('demo.proyecto');
    const id = (await pool.query(`SELECT id FROM app_user WHERE username = 'demo.proyecto'`)).rows[0].id;
    expect((await call('PATCH', `/api/admin/users/${id}`, admin, { active: false })).statusCode).toBe(200);
    expect((await call('GET', '/api/auth/me', cookie)).statusCode).toBe(401);
    expect((await call('PATCH', `/api/admin/users/${id}`, admin, { active: true })).statusCode).toBe(200);
  });

  it('restablecer la contraseña cierra las sesiones y obliga a cambiarla', async () => {
    const admin = await sessionOf(ADMIN.username, ADMIN.password);
    const cookie = await sessionOf('demo.proyecto');
    const id = (await pool.query(`SELECT id FROM app_user WHERE username = 'demo.proyecto'`)).rows[0].id;
    const res = await call('POST', `/api/admin/users/${id}/reset-password`, admin, { newPassword: 'ficticio-restablecida-1' });
    expect(res.statusCode).toBe(200);
    expect((await call('GET', '/api/auth/me', cookie)).statusCode).toBe(401);
    const again = await login('demo.proyecto', 'ficticio-restablecida-1');
    expect(again.res.json().user.mustChangePassword).toBe(true);
  });

  it('el administrador no puede desactivarse ni dejar el sistema sin administradores', async () => {
    const admin = await sessionOf(ADMIN.username, ADMIN.password);
    const id = (await pool.query(`SELECT id FROM app_user WHERE username = 'admin'`)).rows[0].id;
    const off = await call('PATCH', `/api/admin/users/${id}`, admin, { active: false });
    expect(off.statusCode).toBe(409);
    const demote = await call('PATCH', `/api/admin/users/${id}`, admin, { roles: ['USUARIO'] });
    expect(demote.statusCode).toBe(409);
    expect(demote.json().error.code).toBe('ULTIMO_ADMINISTRADOR');
    // Nada ha cambiado: la operación se deshizo entera.
    expect((await call('GET', '/api/admin/users', admin)).statusCode).toBe(200);
  });

  it('un identificador mal formado o inexistente no rompe nada', async () => {
    const admin = await sessionOf(ADMIN.username, ADMIN.password);
    expect((await call('PATCH', '/api/admin/users/no-es-un-id', admin, { active: true })).statusCode).toBe(400);
    expect(
      (await call('PATCH', '/api/admin/users/00000000-0000-4000-8000-000000000000', admin, { fullName: 'X' })).statusCode,
    ).toBe(404);
  });
});

describe('auditoría', () => {
  it('registra entradas, intentos fallidos y cambios de usuarios, con su autor', async () => {
    const admin = await sessionOf(ADMIN.username, ADMIN.password);
    await login('demo.usuario', 'incorrecta');
    await pool.query(`UPDATE app_user SET failed_login_count = 0 WHERE username = 'demo.usuario'`);
    const res = await call('GET', '/api/admin/audit?limit=200', admin);
    expect(res.statusCode).toBe(200);
    const entries = res.json().entries as Array<{ action: string; username: string | null; after: unknown }>;
    const actions = new Set(entries.map((e) => e.action));
    for (const a of ['auth.login', 'auth.login_fallido', 'auth.logout', 'usuario.alta', 'usuario.modificacion',
      'usuario.restablecer_contrasena', 'auth.cambio_contrasena', 'sistema.primer_administrador']) {
      expect(actions, `falta la acción ${a}`).toContain(a);
    }
    const alta = entries.find((e) => e.action === 'usuario.alta')!;
    expect(alta.username).toBe('admin');
    expect(JSON.stringify(alta.after)).not.toMatch(/password|argon2/i);
  });

  it('el primer administrador solo se crea si no hay usuarios', async () => {
    expect(await ensureFirstAdmin(pool, config)).toBe('ya_habia_usuarios');
    expect(await seedDemoUsers(pool)).toBe(0);
  });
});

describe('estado', () => {
  it('responde al control de salud', async () => {
    const res = await call('GET', '/api/health');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
  });

  it('una ruta inexistente devuelve 404 en formato propio', async () => {
    const res = await call('GET', '/api/no-existe');
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('NO_ENCONTRADO');
  });
});
