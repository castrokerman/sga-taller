/**
 * Proyectos, sus responsables y lo reservado. Datos ficticios sobre PostgreSQL real.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { PNG } from 'pngjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { DEMO_PASSWORD, ensureFirstAdmin, seedDemoUsers } from '../src/bootstrap.js';
import type { Config } from '../src/config.js';
import { runMigrations } from '../src/db/migrate.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('Falta TEST_DATABASE_URL');

const config: Config = {
  databaseUrl: url, port: 0, host: '127.0.0.1', cookieSecure: true, cookieName: 'sga_session',
  adminUsername: 'admin', adminPassword: 'ficticio-admin-0001', seedDemo: true, logLevel: 'silent',
  loginRateLimit: 1000,
};

let pool: pg.Pool;
let app: FastifyInstance;
type Cookie = Record<string, string>;
let almacen: Cookie;
let usuario: Cookie;
let consulta: Cookie;
let proyecto: Cookie;
const ids: Record<string, string> = {};

async function sessionOf(username: string): Promise<Cookie> {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/login', headers: { 'x-sga-client': 'web' }, payload: { username, password: DEMO_PASSWORD },
  });
  return { sga_session: res.cookies.find((c) => c.name === 'sga_session')!.value };
}

const call = (method: 'GET' | 'POST' | 'DELETE' | 'PATCH' | 'PUT', path: string, cookies: Cookie, payload?: unknown) =>
  app.inject({
    method, url: path, cookies, payload: payload as never,
    headers: { 'x-sga-client': 'web', ...(method === 'POST' ? { 'idempotency-key': randomUUID() } : {}) },
  });

/** Una imagen PNG pequeña de un color, en base64. */
function png(w: number, h: number, shade = 120): string {
  const img = new PNG({ width: w, height: h });
  img.data.fill(shade);
  return PNG.sync.write(img).toString('base64');
}

let location: string;
let container: string;
let material: string;
let family: string;

beforeAll(async () => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.end();
  await runMigrations(url);
  pool = new pg.Pool({ connectionString: url, max: 6 });
  app = await buildApp({ pool, config });
  await ensureFirstAdmin(pool, config);
  await seedDemoUsers(pool);
  // Las pruebas usan códigos con prefijos de una letra: P01, E01, N01, S01.
  await pool.query(
    `UPDATE location_type SET code_prefix = x.p FROM (VALUES ('PASILLO', 'P'), ('ESTANTERIA', 'E'), ('NIVEL', 'N'), ('POSICION', 'S')) AS x (c, p) WHERE code = x.c`,
  );
  await pool.query(`UPDATE app_user SET must_change_password = false`);
  [almacen, usuario, consulta, proyecto] = (await Promise.all(
    ['demo.almacen', 'demo.usuario', 'demo.consulta', 'demo.proyecto'].map(sessionOf),
  )) as [Cookie, Cookie, Cookie, Cookie];
  for (const u of (await pool.query(`SELECT id, username FROM app_user`)).rows) ids[u.username] = u.id;

  location = (await call('POST', '/api/locations', almacen, { segment: 'PRY', name: 'FICTICIO Zona de proyectos', typeCode: 'ZONA' })).json().location.id;
  container = (await call('POST', '/api/containers', almacen, { typeCode: 'CAJA', locationId: location })).json().containers[0].id;
  family = (await call('GET', '/api/material-families', almacen)).json().families[0].id;
  material = (await call('POST', '/api/materials', almacen, { description: 'FICTICIO Brida', familyId: family, unitCode: 'ud' })).json().material.id;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});



let prjA: string; // responsables: proyecto y usuario; miembro: consulta
let prjB: string; // responsable: usuario
const balanceIn = async (containerId: string) =>
  (await pool.query(`SELECT id, quantity::float AS q FROM stock_balance WHERE container_id = $1 AND material_id = $2`, [containerId, material])).rows[0];

describe('proyectos', () => {
  it('los crean los responsables de almacén, con varios responsables y miembros', async () => {
    const body = { code: 'prj-fict-a', name: 'FICTICIO Banco de ensayos', responsibleIds: [ids['demo.proyecto'], ids['demo.usuario']], memberIds: [ids['demo.consulta']] };
    expect((await call('POST', '/api/projects', proyecto, body)).statusCode).toBe(403);
    const a = await call('POST', '/api/projects', almacen, body);
    expect(a.statusCode, a.body).toBe(201);
    expect(a.json().code).toBe('PRJ-FICT-A');
    prjA = a.json().id;
    const b = await call('POST', '/api/projects', almacen, { code: 'PRJ-FICT-B', name: 'FICTICIO Línea piloto', responsibleIds: [ids['demo.usuario']] });
    prjB = b.json().id;
    expect((await call('POST', '/api/projects', almacen, body)).json().error.code).toBe('PROYECTO_DUPLICADO');
    expect((await call('POST', '/api/projects', almacen, { ...body, code: 'X', responsibleIds: [] })).statusCode).toBe(400);
  });

  it('cada uno ve sus proyectos; quien gestiona, todos', async () => {
    const list = async (who: Cookie) =>
      (await call('GET', '/api/projects', who)).json().projects.map((p: { code: string; myRole: string | null }) => `${p.code}:${p.myRole}`);
    expect(await list(usuario)).toEqual(['PRJ-FICT-A:RESPONSIBLE', 'PRJ-FICT-B:RESPONSIBLE']);
    expect(await list(proyecto)).toEqual(['PRJ-FICT-A:RESPONSIBLE']);
    expect(await list(consulta)).toEqual(['PRJ-FICT-A:MEMBER']);
    expect(await list(almacen)).toEqual(['PRJ-FICT-A:null', 'PRJ-FICT-B:null']);
    const a = (await call('GET', '/api/projects', almacen)).json().projects[0];
    expect(a.responsibles.map((r: { fullName: string }) => r.fullName)).toEqual(['FICTICIO Responsable de Proyecto', 'FICTICIO Usuario Estándar']);
  });

  it('solo los responsables ven todo lo del proyecto', async () => {
    expect((await call('GET', `/api/projects/${prjA}`, consulta)).json().full).toBe(false);
    expect((await call('GET', `/api/projects/${prjB}`, proyecto)).statusCode).toBe(403);
    const d = (await call('GET', `/api/projects/${prjA}`, proyecto)).json();
    expect(d.full).toBe(true);
    expect(d).toHaveProperty('containers');
    expect(d.canEdit).toBe(false);
  });

  it('asignar un contenedor: responsables de almacén o del proyecto', async () => {
    expect((await call('PUT', `/api/containers/${container}/project`, proyecto, { projectId: prjB })).statusCode).toBe(403);
    expect((await call('PUT', `/api/containers/${container}/project`, usuario, { projectId: prjB })).statusCode).toBe(200);
    const k = (await call('GET', `/api/containers/${container}`, consulta)).json().container;
    expect(k).toMatchObject({ projectCode: 'PRJ-FICT-B', projectName: 'FICTICIO Línea piloto' });
    // Para sacarlo de B hay que ser responsable de B.
    expect((await call('PUT', `/api/containers/${container}/project`, proyecto, { projectId: null })).statusCode).toBe(403);
  });

  it('lo que hay en un contenedor del proyecto está reservado para sus responsables', async () => {
    expect((await call('POST', '/api/stock/receipt', almacen, { materialId: material, containerId: container, quantity: 10 })).statusCode).toBe(201);
    const bal = (await balanceIn(container)).id;
    const no = await call('POST', '/api/stock/withdraw', proyecto, { balanceId: bal, quantity: 1 });
    expect(no.statusCode).toBe(403);
    expect(no.json().error.message).toContain('reservado para el proyecto PRJ-FICT-B');
    expect((await call('POST', '/api/stock/transfer', proyecto, { balanceId: bal, quantity: 1, toLocationId: location })).statusCode).toBe(403);
    expect((await call('POST', '/api/stock/withdraw', usuario, { balanceId: bal, quantity: 2 })).statusCode).toBe(200);
    expect((await call('POST', '/api/stock/withdraw', almacen, { balanceId: bal, quantity: 1 })).statusCode).toBe(200);
    expect((await balanceIn(container)).q).toBe(7);
    // Una bolsa dentro de la caja del proyecto también es del proyecto.
    const bolsa = (await call('POST', '/api/containers', almacen, { typeCode: 'CAJA', parentContainerId: container })).json().containers[0].id;
    expect((await call('POST', '/api/stock/receipt', almacen, { materialId: material, containerId: bolsa, quantity: 3 })).statusCode).toBe(201);
    expect((await call('POST', '/api/stock/withdraw', proyecto, { balanceId: (await balanceIn(bolsa)).id, quantity: 1 })).statusCode).toBe(403);
    // La ficha del proyecto lo enseña todo.
    const d = (await call('GET', `/api/projects/${prjB}`, usuario)).json();
    expect(d.containers.map((x: { id: string }) => x.id)).toEqual([container]);
    expect(d.stock.map((x: { quantity: number }) => x.quantity).sort()).toEqual([3, 7]);
    expect(d.movements.length).toBeGreaterThanOrEqual(4);
  });

  it('una recepción para un proyecto avisa a todos sus responsables', async () => {
    const r = await call('POST', '/api/inbound', almacen, {
      projectId: prjA, locationId: location, photos: [{ image: png(40, 30), thumbnail: png(10, 8), width: 40, height: 30 }],
    });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().id;
    for (const who of [proyecto, usuario]) {
      const n = (await call('GET', '/api/notifications', who)).json().notifications.find((x: { entityId: string }) => x.entityId === id);
      expect(n.body).toContain('para el proyecto PRJ-FICT-A');
      expect(n.actionNeeded).toBe(true);
    }
    // Lo completa el segundo responsable; al primero se le da por atendido.
    const done = await call('POST', `/api/inbound/${id}/complete`, usuario, { materialId: material, quantity: 1, disposition: 'STORE' });
    expect(done.statusCode, done.body).toBe(201);
    expect(done.json().message).toContain('(proyecto PRJ-FICT-A · FICTICIO Banco de ensayos)');
    const left = (await call('GET', '/api/notifications', proyecto)).json().notifications.filter((x: { entityId: string }) => x.entityId === id);
    expect(left).toHaveLength(0);
    expect((await call('GET', `/api/projects/${prjA}`, proyecto)).json().inbound[0]).toMatchObject({ id, status: 'DONE' });
  });

  it('se editan responsables, miembros y estado; los cerrados no salen en las listas', async () => {
    expect((await call('PATCH', `/api/projects/${prjA}`, usuario, { name: 'x' })).statusCode).toBe(403);
    const r = await call('PATCH', `/api/projects/${prjA}`, almacen, { responsibleIds: [ids['demo.usuario']], memberIds: [ids['demo.proyecto']], status: 'CLOSED' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().project.members.map((m: { fullName: string }) => m.fullName)).toEqual(['FICTICIO Responsable de Proyecto']);
    expect((await pool.query(`SELECT responsible_user_id FROM project WHERE id = $1`, [prjA])).rows[0].responsible_user_id).toBe(ids['demo.usuario']);
    expect((await call('GET', '/api/projects/options', consulta)).json().projects.map((p: { code: string }) => p.code)).toEqual(['PRJ-FICT-B']);
    expect((await call('GET', '/api/projects', proyecto)).json().projects).toHaveLength(0);
    const audit = (await pool.query(`SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY id`, [prjA])).rows.map((x) => x.action);
    expect(audit).toEqual(['proyecto.alta', 'proyecto.modificacion']);
  });
});

describe('pantalla de movimientos', () => {
  it('solo la ven los responsables de almacén', async () => {
    expect((await call('GET', '/api/stock/movements', usuario)).statusCode).toBe(403);
    expect((await call('GET', '/api/stock/movements', proyecto)).statusCode).toBe(403);
    expect((await call('GET', '/api/stock/movements', almacen)).statusCode).toBe(200);
    // El historial de un contenido se sigue viendo en su ficha.
    expect((await call('GET', `/api/materials/${material}`, usuario)).json().movements.length).toBeGreaterThan(0);
  });
});

describe('borrar usuarios', () => {
  it('desaparece de las listas y no entra, pero el historial conserva su nombre', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-sga-client': 'web' }, payload: { username: 'admin', password: 'ficticio-admin-0001' } });
    const admin = { sga_session: res.cookies.find((c) => c.name === 'sga_session')!.value };
    // Con pendientes no se puede: demo.usuario es el único responsable de PRJ-FICT-A y de PRJ-FICT-B.
    const blocked = await call('DELETE', `/api/admin/users/${ids['demo.usuario']}`, admin);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.message).toContain('es el único responsable de PRJ-FICT-B');
    expect((await call('DELETE', `/api/admin/users/${ids['demo.proyecto']}`, almacen)).statusCode).toBe(403);
    const moves = (await pool.query(`SELECT count(*)::int AS n FROM stock_movement WHERE performed_by = $1`, [ids['demo.consulta']])).rows[0].n;
    const ok = await call('DELETE', `/api/admin/users/${ids['demo.consulta']}`, admin);
    expect(ok.statusCode, ok.body).toBe(200);
    const users = (await call('GET', '/api/admin/users', admin)).json().users.map((u: { fullName: string }) => u.fullName);
    expect(users).not.toContain('FICTICIO Usuario de Consulta');
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-sga-client': 'web' }, payload: { username: 'demo.consulta', password: DEMO_PASSWORD } });
    expect(login.statusCode).toBe(401);
    // Su historial sigue ahí, con su nombre.
    const row = (await pool.query(`SELECT full_name, username, active FROM app_user WHERE id = $1`, [ids['demo.consulta']])).rows[0];
    expect(row).toMatchObject({ full_name: 'FICTICIO Usuario de Consulta', active: false });
    expect(row.username).toMatch(/^borrado-/);
    expect((await pool.query(`SELECT count(*)::int AS n FROM stock_movement WHERE performed_by = $1`, [ids['demo.consulta']])).rows[0].n).toBe(moves);
    // El nombre de usuario queda libre.
    const again = await call('POST', '/api/admin/users', admin, { username: 'demo.consulta', fullName: 'FICTICIO Otra persona', password: 'ficticio-clave-larga-1', roles: ['CONSULTA'] });
    expect(again.statusCode, again.body).toBe(201);
    expect((await call('DELETE', `/api/admin/users/${ids['demo.consulta']}`, admin)).statusCode).toBe(404);
  });
});
