/**
 * Fotos, anotaciones y avisos a responsables. Datos ficticios sobre PostgreSQL real.
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

const call = (method: 'GET' | 'POST' | 'DELETE', path: string, cookies: Cookie, payload?: unknown) =>
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
  await pool.query(`UPDATE app_user SET must_change_password = false`);
  [almacen, usuario, consulta, proyecto] = (await Promise.all(
    ['demo.almacen', 'demo.usuario', 'demo.consulta', 'demo.proyecto'].map(sessionOf),
  )) as [Cookie, Cookie, Cookie, Cookie];
  for (const u of (await pool.query(`SELECT id, username FROM app_user`)).rows) ids[u.username] = u.id;

  location = (await call('POST', '/api/locations', almacen, { segment: 'FOTO', name: 'FICTICIO Zona fotos', typeCode: 'ZONA' })).json().location.id;
  container = (await call('POST', '/api/containers', almacen, { typeCode: 'CAJA', locationId: location })).json().containers[0].id;
  const fam = (await call('GET', '/api/material-families', almacen)).json().families[0].id;
  material = (await call('POST', '/api/materials', almacen, { description: 'FICTICIO Brida', familyId: fam, unitCode: 'ud' })).json().material.id;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('fotos', () => {
  it('se añaden varias; la primera es la principal y sale en la ficha y en las listas', async () => {
    for (const shade of [50, 200]) {
      const r = await call('POST', '/api/photos', usuario, {
        entityType: 'material', entityId: material, image: png(64, 48, shade), thumbnail: png(16, 12, shade), width: 64, height: 48,
      });
      expect(r.statusCode, r.body).toBe(201);
    }
    const list = (await call('GET', `/api/photos?entityType=material&entityId=${material}`, consulta)).json().photos;
    expect(list).toHaveLength(2);
    expect(list.map((p: { position: number }) => p.position)).toEqual([0, 1]);
    expect(list[0].uploadedBy).toBe('FICTICIO Usuario Estándar');
    const m = (await call('GET', `/api/materials/${material}`, consulta)).json().material;
    expect(m.photoId).toBe(list[0].id);

    // Se descarga la imagen y su miniatura, con el tipo correcto.
    const img = await call('GET', `/api/photos/${list[0].id}/image`, consulta);
    expect(img.statusCode).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(PNG.sync.read(img.rawPayload as never).width).toBe(64);
    expect((await call('GET', `/api/photos/${list[0].id}/thumb`, consulta)).statusCode).toBe(200);

    // Cambiar la principal.
    expect((await call('POST', `/api/photos/${list[1].id}/primary`, usuario)).statusCode).toBe(200);
    expect((await call('GET', `/api/materials/${material}`, consulta)).json().material.photoId).toBe(list[1].id);
  });

  it('en ubicaciones y contenedores también, y la principal sale en sus listas', async () => {
    for (const [entityType, entityId] of [['location', location], ['container', container]]) {
      const r = await call('POST', '/api/photos', usuario, { entityType, entityId, image: png(20, 20), thumbnail: png(10, 10), width: 20, height: 20 });
      expect(r.statusCode, r.body).toBe(201);
    }
    expect((await call('GET', `/api/locations/${location}`, usuario)).json().location.photoId).toBeTruthy();
    expect((await call('GET', `/api/containers/${container}`, usuario)).json().container.photoId).toBeTruthy();
  });

  it('rechaza lo que no es una imagen y no deja subir al usuario de consulta', async () => {
    const fake = Buffer.from('<script>alert(1)</script>').toString('base64');
    const r = await call('POST', '/api/photos', usuario, { entityType: 'material', entityId: material, image: fake, thumbnail: fake, width: 1, height: 1 });
    expect(r.json().error.code).toBe('IMAGEN_NO_VALIDA');
    const c = await call('POST', '/api/photos', consulta, { entityType: 'material', entityId: material, image: png(4, 4), thumbnail: png(2, 2), width: 4, height: 4 });
    expect(c.statusCode).toBe(403);
  });

  it('quita la foto quien la subió o un responsable; otro usuario no', async () => {
    const list = (await call('GET', `/api/photos?entityType=material&entityId=${material}`, usuario)).json().photos;
    expect((await call('DELETE', `/api/photos/${list[0].id}`, proyecto)).statusCode).toBe(403);
    expect((await call('DELETE', `/api/photos/${list[0].id}`, almacen)).statusCode).toBe(200);
    const after = (await call('GET', `/api/photos?entityType=material&entityId=${material}`, usuario)).json().photos;
    expect(after).toHaveLength(1);
    expect(after[0].position).toBe(0);
  });
});

describe('anotaciones', () => {
  it('llevan fecha, hora y autor, y no se pueden modificar ni borrar', async () => {
    const r = await call('POST', '/api/notes', usuario, { entityType: 'container', entityId: container, body: 'FICTICIO La caja tiene una esquina rota' });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().note).toMatchObject({ createdBy: 'FICTICIO Usuario Estándar', notify: false, recipients: [] });
    expect(new Date(r.json().note.createdAt).getTime()).toBeGreaterThan(Date.now() - 60_000);
    await expect(pool.query(`UPDATE note SET body = 'otra cosa' WHERE id = $1`, [r.json().note.id])).rejects.toMatchObject({ code: 'SG011' });
    await expect(pool.query(`DELETE FROM note WHERE id = $1`, [r.json().note.id])).rejects.toMatchObject({ code: 'SG011' });
    expect((await call('POST', '/api/notes', consulta, { entityType: 'container', entityId: container, body: 'x' })).statusCode).toBe(403);
  });

  it('en un contenedor se propone avisar a los responsables de almacén y a su responsable', async () => {
    await pool.query(`UPDATE container SET responsible_user_id = $1 WHERE id = $2`, [ids['demo.proyecto'], container]);
    const r = (await call('GET', `/api/notes/recipients?entityType=container&entityId=${container}`, usuario)).json();
    expect(new Set(r.suggested)).toEqual(new Set([ids['demo.almacen'], ids['demo.proyecto']]));
    // En una ubicación, solo los responsables de almacén.
    const l = (await call('GET', `/api/notes/recipients?entityType=location&entityId=${location}`, usuario)).json();
    expect(l.suggested).toEqual([ids['demo.almacen']]);
    // Quien escribe no se avisa a sí mismo.
    const own = (await call('GET', `/api/notes/recipients?entityType=location&entityId=${location}`, almacen)).json();
    expect(own.suggested).toEqual([]);
  });

  it('al notificar, cada destinatario recibe un aviso que puede marcar como leído', async () => {
    const r = await call('POST', '/api/notes', usuario, {
      entityType: 'container', entityId: container, body: 'FICTICIO Falta la tapa', notify: true,
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().notified).toBe(2);
    expect(r.json().note.recipients).toEqual(['FICTICIO Responsable de Almacén', 'FICTICIO Responsable de Proyecto']);

    expect((await call('GET', '/api/notifications/count', almacen)).json().unread).toBe(1);
    const list = (await call('GET', '/api/notifications', almacen)).json().notifications;
    expect(list[0]).toMatchObject({ body: 'FICTICIO Falta la tapa', createdBy: 'FICTICIO Usuario Estándar', entityType: 'container' });
    expect(list[0].entityCode).toMatch(/^CAJ-/);
    // Un usuario no puede marcar avisos de otro.
    expect((await call('POST', `/api/notifications/${list[0].id}/read`, usuario)).statusCode).toBe(404);
    expect((await call('POST', `/api/notifications/${list[0].id}/read`, almacen)).statusCode).toBe(200);
    expect((await call('GET', '/api/notifications/count', almacen)).json().unread).toBe(0);
    expect((await call('GET', '/api/notifications?all=true', almacen)).json().notifications).toHaveLength(1);
  });

  it('se puede elegir a quién avisar', async () => {
    const r = await call('POST', '/api/notes', almacen, {
      entityType: 'material', entityId: material, body: 'FICTICIO Revisar stock', notify: true, recipientIds: [ids['demo.usuario']],
    });
    expect(r.json().notified).toBe(1);
    expect((await call('GET', '/api/notifications/count', usuario)).json().unread).toBe(1);
    expect((await call('POST', '/api/notifications/read-all', usuario)).json().marked).toBe(1);
    const none = await call('POST', '/api/notes', almacen, { entityType: 'material', entityId: material, body: 'x', notify: true, recipientIds: [] });
    expect(none.json().error.code).toBe('SIN_DESTINATARIOS');
  });

  it('la lista de anotaciones sale de la más reciente a la más antigua', async () => {
    const notes = (await call('GET', `/api/notes?entityType=container&entityId=${container}`, consulta)).json().notes;
    expect(notes.map((n: { body: string }) => n.body)).toEqual(['FICTICIO Falta la tapa', 'FICTICIO La caja tiene una esquina rota']);
  });
});
