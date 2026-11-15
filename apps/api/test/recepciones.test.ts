/**
 * Recepciones pendientes de identificar. Datos ficticios sobre PostgreSQL real.
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

  location = (await call('POST', '/api/locations', almacen, { segment: 'REC', name: 'FICTICIO Zona de recepción', typeCode: 'ZONA' })).json().location.id;
  container = (await call('POST', '/api/containers', almacen, { typeCode: 'CAJA', locationId: location })).json().containers[0].id;
  family = (await call('GET', '/api/material-families', almacen)).json().families[0].id;
  material = (await call('POST', '/api/materials', almacen, { description: 'FICTICIO Brida', familyId: family, unitCode: 'ud' })).json().material.id;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});


const photo = () => ({ image: png(40, 30), thumbnail: png(10, 8), width: 40, height: 30 });
const receive = (who: Cookie, extra: Record<string, unknown> = {}) =>
  call('POST', '/api/inbound', who, { responsibleUserId: ids['demo.proyecto'], containerId: container, photos: [photo()], ...extra });
const balances = async (materialId: string) =>
  (await pool.query(`SELECT container_id, location_id, quantity::float AS q FROM stock_balance WHERE material_id = $1`, [materialId])).rows;

describe('recepción pendiente de identificar', () => {
  let first: string;

  it('se registra con foto, responsable y sitio provisional, y avisa al responsable', async () => {
    const r = await receive(almacen, { description: 'FICTICIO Caja de cartón con tres piezas', packages: 1, externalReference: 'ALB-FICT-1' });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ notified: true, responsible: expect.any(String) });
    expect(r.json().code).toMatch(/^REC-\d{6}$/);
    first = r.json().id;

    const n = (await call('GET', '/api/notifications', proyecto)).json().notifications;
    expect(n[0]).toMatchObject({ kind: 'inbound', entityType: 'inbound', entityId: first, actionNeeded: true, inboundStatus: 'PENDING' });
    expect(n[0].body).toContain('está en CAJ-');
    expect((await call('GET', '/api/inbound/count', proyecto)).json()).toMatchObject({ mine: 1, total: null });
    expect((await call('GET', '/api/inbound/count', almacen)).json()).toMatchObject({ received: 1, total: 1 });
    const mine = (await call('GET', '/api/inbound', proyecto)).json().items;
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ status: 'PENDING', photoCount: 1, packages: 1, externalReference: 'ALB-FICT-1' });
  });

  it('la foto es obligatoria y el responsable tiene que existir', async () => {
    expect((await receive(almacen, { photos: [] })).statusCode).toBe(400);
    expect((await receive(almacen, { responsibleUserId: randomUUID() })).statusCode).toBe(400);
    expect((await receive(consulta)).statusCode).toBe(403);
  });

  it('solo la ven quien la registró, el responsable y quien gestiona las recepciones', async () => {
    expect((await call('GET', `/api/inbound/${first}`, usuario)).statusCode).toBe(403);
    const photoId = (await call('GET', '/api/inbound', proyecto)).json().items[0].photoId;
    expect((await call('GET', `/api/photos/${photoId}/thumb`, usuario)).statusCode).toBe(403);
    expect((await call('GET', `/api/photos/${photoId}/thumb`, proyecto)).statusCode).toBe(200);
    expect((await call('GET', '/api/inbound', usuario)).json().items).toHaveLength(0);
    const d = (await call('GET', `/api/inbound/${first}`, proyecto)).json();
    expect(d).toMatchObject({ canComplete: true, canCancel: false });
    // Otro usuario no puede completarla.
    const r = await call('POST', `/api/inbound/${first}/complete`, usuario, { materialId: material, quantity: 1, disposition: 'STORE' });
    expect(r.statusCode).toBe(403);
  });

  it('el responsable la completa con un material nuevo: se guarda donde está y la foto pasa a la ficha', async () => {
    const r = await call('POST', `/api/inbound/${first}/complete`, proyecto, {
      newMaterial: { description: 'FICTICIO Sensor inductivo M12', familyId: family, unitCode: 'ud', manufacturer: 'FICTICIO' },
      quantity: 3, projectRef: 'PRJ-FICT-01', usagePlace: 'Banco de pruebas 2', disposition: 'STORE', usePhotoForMaterial: true,
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().message).toContain('Se queda guardado en CAJ-');
    const mat = r.json().materialId;
    expect(await balances(mat)).toEqual([{ container_id: container, location_id: null, q: 3 }]);
    expect((await pool.query(`SELECT count(*)::int AS n FROM photo WHERE entity_type = 'material' AND entity_id = $1`, [mat])).rows[0].n).toBe(1);
    const d = (await call('GET', `/api/inbound/${first}`, almacen)).json().item;
    expect(d).toMatchObject({ status: 'DONE', quantity: 3, projectRef: 'PRJ-FICT-01', disposition: 'STORE', materialDescription: 'FICTICIO Sensor inductivo M12' });
    // El aviso del responsable queda atendido y quien la recibió recibe la respuesta.
    expect((await call('GET', '/api/notifications', proyecto)).json().notifications).toHaveLength(0);
    const back = (await call('GET', '/api/notifications', almacen)).json().notifications[0];
    expect(back).toMatchObject({ kind: 'inbound', entityId: first, actionNeeded: false });
    expect(back.body).toContain('3 ud de FICTICIO Sensor inductivo M12 (proyecto PRJ-FICT-01)');
    // El movimiento lleva la recepción y el proyecto.
    const mv = (await pool.query(`SELECT movement_type, reason FROM stock_movement WHERE id = (SELECT receipt_movement_id FROM inbound_item WHERE id = $1)`, [first])).rows[0];
    expect(mv.movement_type).toBe('RECEIPT');
    expect(mv.reason).toContain('proyecto PRJ-FICT-01');
    // No se completa dos veces.
    const again = await call('POST', `/api/inbound/${first}/complete`, proyecto, { materialId: material, quantity: 1, disposition: 'STORE' });
    expect(again.statusCode).toBe(409);
    expect((await call('GET', '/api/inbound/projects', usuario)).json().projects).toContain('PRJ-FICT-01');
  });

  it('si se despliega del tirón, entra y sale: queda la huella y no queda stock', async () => {
    const id = (await receive(almacen)).json().id;
    const r = await call('POST', `/api/inbound/${id}/complete`, proyecto, {
      materialId: material, quantity: 2, usagePlace: 'Línea de montaje', disposition: 'DEPLOY',
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().message).toContain('Se despliega directamente en Línea de montaje');
    expect(await balances(material)).toEqual([]);
    const types = (await pool.query(
      `SELECT movement_type FROM stock_movement WHERE id IN (SELECT receipt_movement_id FROM inbound_item WHERE id = $1 UNION SELECT withdrawal_movement_id FROM inbound_item WHERE id = $1) ORDER BY movement_number`,
      [id],
    )).rows.map((x) => x.movement_type);
    expect(types).toEqual(['RECEIPT', 'WITHDRAWAL']);
  });

  it('se puede pasar a otra persona, que la guarda en otro sitio', async () => {
    const id = (await receive(almacen)).json().id;
    const re = await call('POST', `/api/inbound/${id}/reassign`, proyecto, { responsibleUserId: ids['demo.usuario'], note: 'Es del montaje' });
    expect(re.statusCode).toBe(200);
    expect((await call('GET', `/api/inbound/${id}`, proyecto)).statusCode).toBe(403);
    const n = (await call('GET', '/api/notifications', usuario)).json().notifications[0];
    expect(n).toMatchObject({ entityId: id, actionNeeded: true });
    expect(n.body).toContain('Es del montaje');
    const r = await call('POST', `/api/inbound/${id}/complete`, usuario, { materialId: material, quantity: 4, disposition: 'STORE', locationId: location });
    expect(r.statusCode).toBe(201);
    expect(r.json().message).toMatch(/Hay que llevarlo de CAJ-\d+ a REC\./);
    expect(await balances(material)).toEqual([{ container_id: null, location_id: location, q: 4 }]);
  });

  it('se anula con motivo, y entonces ya no se puede completar', async () => {
    const id = (await receive(almacen)).json().id;
    expect((await call('POST', `/api/inbound/${id}/cancel`, proyecto, { reason: 'x' })).statusCode).toBe(403);
    expect((await call('POST', `/api/inbound/${id}/cancel`, almacen, { reason: 'Registrada dos veces' })).statusCode).toBe(200);
    const r = await call('POST', `/api/inbound/${id}/complete`, proyecto, { materialId: material, quantity: 1, disposition: 'STORE' });
    expect(r.statusCode).toBe(409);
    expect((await call('GET', `/api/inbound/${id}`, almacen)).json().item).toMatchObject({ status: 'CANCELLED', cancelReason: 'Registrada dos veces' });
    const audit = (await pool.query(`SELECT action FROM audit_log WHERE entity_id = $1 ORDER BY id`, [id])).rows.map((x) => x.action);
    expect(audit).toEqual(['recepcion.alta', 'recepcion.anulada']);
  });
});
