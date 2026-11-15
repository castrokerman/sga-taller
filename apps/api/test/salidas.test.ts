/**
 * Registrar salidas del taller: definitivas y temporales, de contenido suelto
 * o de un contenedor entero; vuelta, nuevo plazo y aviso al vencer.
 * Datos ficticios sobre un PostgreSQL real.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import pg from 'pg';
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

async function sessionOf(username: string): Promise<Cookie> {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/login', headers: { 'x-sga-client': 'web' }, payload: { username, password: DEMO_PASSWORD },
  });
  return { sga_session: res.cookies.find((c) => c.name === 'sga_session')!.value };
}

const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, cookies: Cookie, payload?: unknown) =>
  app.inject({
    method, url: path, cookies, payload: payload as never,
    headers: { 'x-sga-client': 'web', ...(method === 'POST' ? { 'idempotency-key': randomUUID() } : {}) },
  });

import { notifyDueDepartures } from '../src/routes/departures.js';

async function loc(segment: string, typeCode: string, parentId?: string) {
  const res = await call('POST', '/api/locations', almacen, { segment, name: `FICTICIO ${segment}`, typeCode, parentId });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().location as { id: string; code: string };
}

let zona: { id: string; code: string };
let fam: string;
const familyFor = async (type: unknown) =>
  type
    ? ((await pool.query(`SELECT id FROM material_family WHERE content_type_code = $1 AND active ORDER BY name LIMIT 1`, [type])).rows[0]?.id as string | undefined) ?? fam
    : fam;
const material = async (description: string, extra: Record<string, unknown> = {}) =>
  (await call('POST', '/api/materials', almacen, { description, familyId: await familyFor(extra.contentTypeCode), unitCode: 'ud', ...extra })).json().material.id as string;
const caja = async (where: string) => (await call('POST', '/api/containers', almacen, { typeCode: 'CAJA', locationId: where })).json().containers[0] as { id: string; code: string };
const balanceOf = async (materialId: string) =>
  (await pool.query(`SELECT id, quantity::float AS q, container_id AS "containerId" FROM stock_balance WHERE material_id = $1`, [materialId])).rows;

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
  [almacen, usuario] = await Promise.all([sessionOf('demo.almacen'), sessionOf('demo.usuario')]);
  zona = await loc('SAL', 'ZONA');
  fam = (await call('GET', '/api/material-families', almacen)).json().families.find((f: { contentTypeCode: string | null }) => !f.contentTypeCode || f.contentTypeCode === 'MATERIAL').id;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('salidas del taller', () => {
  it('salida temporal de contenido: sale, queda abierta y al volver regresa a su sitio', async () => {
    const k = await caja(zona.id);
    const m = await material('FICTICIO Brida');
    expect((await call('POST', '/api/stock/receipt', almacen, { materialId: m, containerId: k.id, quantity: 10 })).statusCode).toBe(201);
    const bal = (await balanceOf(m))[0];
    const r = await call('POST', '/api/departures', almacen, {
      kind: 'TEMPORARY', destination: 'FICTICIO Proveedor de calibración', days: 7, lines: [{ balanceId: bal.id, quantity: 4 }],
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().code).toMatch(/^SAL-/);
    expect(r.json().containers).toEqual([{ id: k.id, code: k.code }]);
    expect((await balanceOf(m))[0].q).toBe(6);
    const open = (await call('GET', '/api/departures', almacen)).json().departures;
    expect(open.find((d: { id: string }) => d.id === r.json().id)).toMatchObject({ status: 'OUT', overdue: false, lines: [{ quantity: 4 }] });
    // Vuelta: a su sitio de origen.
    const back = await call('POST', `/api/departures/${r.json().id}/return`, almacen, {});
    expect(back.statusCode, back.body).toBe(200);
    expect((await balanceOf(m))[0].q).toBe(10);
    expect((await call('POST', `/api/departures/${r.json().id}/return`, almacen, {})).statusCode).toBe(409);
  });

  it('salida temporal de un contenedor entero: queda fuera, no se puede tocar y vuelve a donde se elija', async () => {
    const k = await caja(zona.id);
    const m = await material('FICTICIO Sensor');
    await call('POST', '/api/stock/receipt', almacen, { materialId: m, containerId: k.id, quantity: 3 });
    const r = await call('POST', '/api/departures', almacen, { kind: 'TEMPORARY', destination: 'FICTICIO Obra Bilbao', dueDate: '2099-01-31', containerId: k.id });
    expect(r.statusCode, r.body).toBe(201);
    const det = (await call('GET', `/api/containers/${k.id}`, almacen)).json().container;
    expect(det.status).toBe('OUT');
    // Mientras está fuera no se puede meter ni sacar nada.
    const bal = (await balanceOf(m))[0];
    const no = await call('POST', '/api/stock/withdraw', almacen, { balanceId: bal.id, quantity: 1, reason: 'FICTICIO' });
    expect(no.statusCode).toBe(409);
    expect(no.json().error.message).toContain('fuera del taller');
    expect((await call('POST', '/api/stock/receipt', almacen, { materialId: m, containerId: k.id, quantity: 1 })).statusCode).toBe(409);
    // Vuelve a otra ubicación.
    const otra = await loc('SAL2', 'ZONA');
    const back = await call('POST', `/api/departures/${r.json().id}/return`, almacen, { toLocationId: otra.id });
    expect(back.statusCode, back.body).toBe(200);
    const after = (await call('GET', `/api/containers/${k.id}`, almacen)).json().container;
    expect(after).toMatchObject({ status: 'ACTIVE', locationId: otra.id });
    expect((await balanceOf(m))[0].q).toBe(3);
  });

  it('salida definitiva: pide motivo; el contenedor queda retirado y las unidades con código, de baja', async () => {
    const k = await caja(zona.id);
    const tornillo = await material('FICTICIO Tornillo');
    const llave = await material('FICTICIO Llave', { contentTypeCode: 'HERRAMIENTA' });
    await call('POST', '/api/stock/receipt', almacen, { materialId: tornillo, containerId: k.id, quantity: 50 });
    await call('POST', '/api/stock/receipt', almacen, { materialId: llave, containerId: k.id, quantity: 1 });
    expect((await call('POST', '/api/departures', almacen, { kind: 'DEFINITIVE', destination: 'FICTICIO Cliente', containerId: k.id })).statusCode).toBe(400);
    const r = await call('POST', '/api/departures', almacen, { kind: 'DEFINITIVE', destination: 'FICTICIO Cliente', reason: 'Entrega del prototipo', containerId: k.id });
    expect(r.statusCode, r.body).toBe(201);
    expect((await call('GET', `/api/containers/${k.id}`, almacen)).json().container.status).toBe('RETIRED');
    expect(await balanceOf(tornillo)).toEqual([]);
    expect((await call('GET', `/api/materials/${llave}`, almacen)).json().material.status).toBe('OBSOLETE');
    expect((await call('GET', `/api/materials/${tornillo}`, almacen)).json().material.status).toBe('ACTIVE');
    const d = (await call('GET', `/api/departures/${r.json().id}`, almacen)).json().departure;
    expect(d).toMatchObject({ kind: 'DEFINITIVE', status: 'DONE', containerCode: k.code });
    expect(d.lines).toHaveLength(2);
  });

  it('al vencer, avisa al responsable para que diga si ha regresado; puede ampliar el plazo', async () => {
    const m = await material('FICTICIO Polímetro');
    const k = await caja(zona.id);
    await call('POST', '/api/stock/receipt', almacen, { materialId: m, containerId: k.id, quantity: 1 });
    const usuarioId = (await pool.query(`SELECT id FROM app_user WHERE username = 'demo.usuario'`)).rows[0].id;
    const r = await call('POST', '/api/departures', almacen, {
      kind: 'TEMPORARY', destination: 'FICTICIO Feria', days: 1, responsibleUserId: usuarioId, lines: [{ balanceId: (await balanceOf(m))[0].id }],
    });
    expect(r.statusCode, r.body).toBe(201);
    const id = r.json().id;
    await pool.query(`UPDATE departure SET due_at = now() - interval '1 hour' WHERE id = $1`, [id]);
    expect(await notifyDueDepartures(pool)).toBe(1);
    expect(await notifyDueDepartures(pool)).toBe(0); // un solo aviso
    const n = (await call('GET', '/api/notifications', usuario)).json().notifications.find((x: { entityId: string }) => x.entityId === id);
    expect(n).toMatchObject({ kind: 'departure', entityType: 'departure', actionNeeded: true });
    expect(n.body).toContain('¿Ha regresado a las instalaciones de IDOM?');
    // Aún no: nuevo plazo; el aviso queda leído.
    const ext = await call('POST', `/api/departures/${id}/extend`, usuario, { days: 3 });
    expect(ext.statusCode, ext.body).toBe(200);
    expect((await call('GET', '/api/notifications/count', usuario)).json().unread).toBe(0);
    expect((await call('GET', '/api/departures', almacen)).json().departures.find((d: { id: string }) => d.id === id).overdue).toBe(false);
  });

  it('el contenedor se queda para reutilizarlo: sale solo lo de dentro y vuelve a él', async () => {
    const k = await caja(zona.id);
    const m = await material('FICTICIO Placa');
    await call('POST', '/api/stock/receipt', almacen, { materialId: m, containerId: k.id, quantity: 5 });
    const r = await call('POST', '/api/departures', almacen, {
      kind: 'TEMPORARY', destination: 'FICTICIO Feria', days: 3, containerId: k.id, keepContainer: true,
    });
    expect(r.statusCode, r.body).toBe(201);
    expect(r.json().message).toContain(`${k.code} se queda en el taller`);
    const det = (await call('GET', `/api/containers/${k.id}`, almacen)).json().container;
    expect(det).toMatchObject({ status: 'ACTIVE', locationId: zona.id });
    expect(await balanceOf(m)).toEqual([]);
    const d = (await call('GET', `/api/departures/${r.json().id}`, almacen)).json().departure;
    expect(d).toMatchObject({ containerId: null, keptContainerCode: k.code, lines: [{ quantity: 5 }] });
    // Mientras, el contenedor se puede usar para otra cosa.
    const otro = await material('FICTICIO Otro');
    expect((await call('POST', '/api/stock/receipt', almacen, { materialId: otro, containerId: k.id, quantity: 1 })).statusCode).toBe(201);
    // Al volver, el contenido regresa a su contenedor.
    expect((await call('POST', `/api/departures/${r.json().id}/return`, almacen, {})).statusCode).toBe(200);
    expect((await balanceOf(m))[0]).toMatchObject({ q: 5, containerId: k.id });
    // Definitiva dejando el contenedor: sigue activo; vacío no se puede.
    const def = await call('POST', '/api/departures', almacen, {
      kind: 'DEFINITIVE', destination: 'FICTICIO Cliente', reason: 'Entrega', containerId: k.id, keepContainer: true,
    });
    expect(def.statusCode, def.body).toBe(201);
    expect((await call('GET', `/api/containers/${k.id}`, almacen)).json().container.status).toBe('ACTIVE');
    const vacio = await call('POST', '/api/departures', almacen, {
      kind: 'DEFINITIVE', destination: 'FICTICIO Cliente', reason: 'Entrega', containerId: k.id, keepContainer: true,
    });
    expect(vacio.statusCode).toBe(409);
  });
});
