/**
 * Pruebas de la Fase 2: ubicaciones, contenedores anidados, movimientos y escaneo.
 * Cubren los escenarios 2 (parte de contenedores), 3, 11 y 16 del plan de pruebas.
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
let almacen: Cookie; // responsable de almacén: gestiona y mueve
let usuario: Cookie; // usuario estándar: mueve, no gestiona
let consulta: Cookie; // solo lectura
let admin: Cookie;

async function sessionOf(username: string, password = DEMO_PASSWORD): Promise<Cookie> {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/login', headers: { 'x-sga-client': 'web' }, payload: { username, password },
  });
  expect(res.statusCode).toBe(200);
  return { sga_session: res.cookies.find((c) => c.name === 'sga_session')!.value };
}

const call = (method: 'GET' | 'POST' | 'PATCH', path: string, cookies: Cookie, payload?: unknown, key: string | null = randomUUID()) =>
  app.inject({
    method, url: path, cookies, payload: payload as never,
    headers: { 'x-sga-client': 'web', ...(method !== 'GET' && key ? { 'idempotency-key': key } : {}) },
  });

async function newLocation(code: string, typeCode: string, parentId?: string, extra: Record<string, unknown> = {}) {
  const res = await call('POST', '/api/locations', almacen, { code, name: `FICTICIO ${code}`, typeCode, parentId, ...extra });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().location as { id: string; code: string; qrToken: string };
}

async function newContainers(typeCode: string, where: { locationId?: string; parentContainerId?: string }, quantity = 1) {
  const res = await call('POST', '/api/containers', almacen, { typeCode, quantity, ...where });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().containers as Array<{ id: string; code: string; qrToken: string }>;
}

const detail = async (id: string) => (await call('GET', `/api/containers/${id}`, consulta)).json();

// Árbol ficticio común a todas las pruebas.
let zona: { id: string };
let s01: { id: string; qrToken: string };
let s02: { id: string };
let armario: { id: string };

beforeAll(async () => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.end();
  await runMigrations(url);
  pool = new pg.Pool({ connectionString: url, max: 8 });
  app = await buildApp({ pool, config });
  await ensureFirstAdmin(pool, config);
  await seedDemoUsers(pool);
  await pool.query(`UPDATE app_user SET must_change_password = false`);
  [almacen, usuario, consulta, admin] = await Promise.all([
    sessionOf('demo.almacen'), sessionOf('demo.usuario'), sessionOf('demo.consulta'),
    sessionOf('admin', 'ficticio-admin-0001'),
  ]);

  zona = await newLocation('ALM-A', 'ZONA');
  const pasillo = await newLocation('ALM-A-P01', 'PASILLO', zona.id);
  const estanteria = await newLocation('ALM-A-P01-E01', 'ESTANTERIA', pasillo.id);
  const nivel = await newLocation('ALM-A-P01-E01-N02', 'NIVEL', estanteria.id);
  s01 = await newLocation('ALM-A-P01-E01-N02-S01', 'POSICION', nivel.id);
  s02 = await newLocation('ALM-A-P01-E01-N02-S02', 'POSICION', nivel.id);
  const com = await newLocation('COM', 'ZONA');
  armario = await newLocation('COM-ARM-01', 'ARMARIO', com.id, { allowedHazardClasses: ['LIQUIDO'] });
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('ubicaciones', () => {
  it('se organizan en árbol y cada una conoce su ruta completa', async () => {
    const roots = (await call('GET', '/api/locations', consulta)).json().locations;
    expect(roots.map((l: { code: string }) => l.code)).toEqual(['ALM-A', 'COM']);

    const d = (await call('GET', `/api/locations/${s01.id}`, consulta)).json();
    expect(d.path.map((p: { code: string }) => p.code)).toEqual([
      'ALM-A', 'ALM-A-P01', 'ALM-A-P01-E01', 'ALM-A-P01-E01-N02', 'ALM-A-P01-E01-N02-S01',
    ]);
    expect(d.location).toMatchObject({ typeCode: 'POSICION', active: true });
    expect(d.location.qrToken).toMatch(/^[2-9A-HJKMNP-TV-Z]{20}$/);
  });

  it('rechaza códigos duplicados o mal formados y tipos inexistentes', async () => {
    const base = { name: 'FICTICIO', typeCode: 'ZONA' };
    expect((await call('POST', '/api/locations', almacen, { ...base, code: 'ALM-A' })).statusCode).toBe(409);
    expect((await call('POST', '/api/locations', almacen, { ...base, code: 'con espacios' })).statusCode).toBe(400);
    expect((await call('POST', '/api/locations', almacen, { ...base, code: 'FIC-X', typeCode: 'NO_EXISTE' })).statusCode).toBe(400);
  });

  it('solo quien gestiona el almacén puede crearlas o cambiarlas', async () => {
    const body = { code: 'FIC-NO', name: 'FICTICIO', typeCode: 'ZONA' };
    expect((await call('POST', '/api/locations', usuario, body)).statusCode).toBe(403);
    expect((await call('POST', '/api/locations', consulta, body)).statusCode).toBe(403);
    expect((await call('PATCH', `/api/locations/${zona.id}`, usuario, { name: 'X' })).statusCode).toBe(403);
  });

  it('no permite ciclos ni colgar una ubicación de sí misma', async () => {
    expect((await call('PATCH', `/api/locations/${zona.id}`, almacen, { parentId: s01.id })).statusCode).toBe(409);
    expect((await call('PATCH', `/api/locations/${zona.id}`, almacen, { parentId: zona.id })).statusCode).toBe(409);
  });

  it('se puede renombrar y recodificar sin que cambie su QR', async () => {
    const loc = await newLocation('FIC-RENOMBRAR', 'AREA');
    const res = await call('PATCH', `/api/locations/${loc.id}`, almacen, { code: 'FIC-RENOMBRADA', name: 'FICTICIO nuevo nombre' });
    expect(res.statusCode).toBe(200);
    expect(res.json().location).toMatchObject({ code: 'FIC-RENOMBRADA', qrToken: loc.qrToken });
  });

  it('no se desactiva si contiene ubicaciones o contenedores', async () => {
    const res = await call('PATCH', `/api/locations/${zona.id}`, almacen, { active: false });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('UBICACION_NO_VACIA');

    const empty = await newLocation('FIC-VACIA', 'AREA');
    expect((await call('PATCH', `/api/locations/${empty.id}`, almacen, { active: false })).statusCode).toBe(200);
    // Una ubicación desactivada no admite contenedores.
    const res2 = await call('POST', '/api/containers', almacen, { typeCode: 'CAJA', locationId: empty.id });
    expect(res2.statusCode).toBe(409);
  });

  it('el administrador puede añadir tipos nuevos de ubicación y de contenedor', async () => {
    expect((await call('POST', '/api/location-types', usuario, { code: 'MURO', name: 'Muro' })).statusCode).toBe(403);
    expect((await call('POST', '/api/location-types', admin, { code: 'MURO', name: 'Muro de herramientas' })).statusCode).toBe(201);
    expect((await call('POST', '/api/location-types', admin, { code: 'MURO', name: 'Otra vez' })).statusCode).toBe(409);
    await newLocation('FIC-MURO', 'MURO');

    const t = await call('POST', '/api/container-types', admin, { code: 'JAULA', name: 'Jaula', codePrefix: 'JAU' });
    expect(t.statusCode).toBe(201);
    const [jaula] = await newContainers('JAULA', { locationId: s02.id });
    expect(jaula!.code).toBe('JAU-000001');
  });
});

describe('contenedores', () => {
  it('reciben códigos legibles consecutivos y un QR propio', async () => {
    const [a] = await newContainers('PALET', { locationId: s02.id });
    const [b] = await newContainers('PALET', { locationId: s02.id });
    const na = Number(a!.code.slice(4));
    expect(a!.code).toMatch(/^PAL-\d{6}$/);
    expect(Number(b!.code.slice(4))).toBe(na + 1);
    expect(a!.qrToken).not.toBe(b!.qrToken);
    expect(a!.qrToken).toMatch(/^[2-9A-HJKMNP-TV-Z]{20}$/);
  });

  it('altas simultáneas no repiten código', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => newContainers('BANDEJA', { locationId: s02.id }, 2)));
    const codes = results.flat().map((c) => c.code);
    expect(new Set(codes).size).toBe(12);
  });

  it('deben estar en una ubicación o dentro de otro contenedor, no ambas ni ninguna', async () => {
    const [p] = await newContainers('PALET', { locationId: s02.id });
    expect((await call('POST', '/api/containers', almacen, { typeCode: 'CAJA' })).statusCode).toBe(400);
    expect(
      (await call('POST', '/api/containers', almacen, { typeCode: 'CAJA', locationId: s02.id, parentContainerId: p!.id })).statusCode,
    ).toBe(400);
  });

  it('escenario 2: un palet se divide en dos cajas, cada una con identificación propia', async () => {
    const [pallet] = await newContainers('PALET', { locationId: s02.id });
    const boxes = await newContainers('CAJA', { parentContainerId: pallet!.id }, 2);
    expect(boxes).toHaveLength(2);

    const p = await detail(pallet!.id);
    expect(p.children.map((c: { code: string }) => c.code)).toEqual(boxes.map((b) => b.code));

    const b = await detail(boxes[0]!.id);
    expect(b.containerPath.map((c: { code: string }) => c.code)).toEqual([pallet!.code, boxes[0]!.code]);
    expect(b.locationPath.at(-1).code).toBe('ALM-A-P01-E01-N02-S02');
    expect(b.container.reusePolicy).toBe('DISPOSABLE'); // las cajas son desechables por defecto
    expect(p.container.reusePolicy).toBe('REUSABLE');
  });

  it('una operación reenviada con la misma clave no crea contenedores de más (escenario 16)', async () => {
    const key = randomUUID();
    const body = { typeCode: 'CAJA', locationId: s02.id, quantity: 3 };
    const count = async () => (await pool.query(`SELECT count(*)::int AS n FROM container`)).rows[0].n;
    const before = await count();

    const first = await call('POST', '/api/containers', almacen, body, key);
    const second = await call('POST', '/api/containers', almacen, body, key);
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.json()).toEqual(first.json());
    expect(await count()).toBe(before + 3);

    // La misma clave no vale para una operación distinta, ni se admite una operación sin clave.
    expect((await call('POST', '/api/containers', almacen, { ...body, quantity: 1 }, key)).statusCode).toBe(422);
    expect((await call('POST', '/api/containers', almacen, body, null)).statusCode).toBe(400);
    expect(await count()).toBe(before + 3);
  });

  it('se pueden editar la descripción, el responsable y la política', async () => {
    const [c] = await newContainers('CAJA', { locationId: s02.id });
    const users = (await call('GET', '/api/users/basic', consulta)).json().users as Array<{ id: string; fullName: string }>;
    const res = await call('PATCH', `/api/containers/${c!.id}`, almacen, {
      description: 'FICTICIO tornillería variada', responsibleUserId: users[0]!.id, reusePolicy: 'REUSABLE',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().container).toMatchObject({
      description: 'FICTICIO tornillería variada', responsibleName: users[0]!.fullName, reusePolicy: 'REUSABLE',
    });
    const cleared = await call('PATCH', `/api/containers/${c!.id}`, almacen, { responsibleUserId: null });
    expect(cleared.json().container.responsibleUserId).toBeNull();
    expect((await call('PATCH', `/api/containers/${c!.id}`, usuario, { description: 'x' })).statusCode).toBe(403);
  });
});

describe('movimientos', () => {
  it('escenarios 3 y 11: mover un palet mueve todo lo que lleva dentro con un solo movimiento', async () => {
    const [pallet] = await newContainers('PALET', { locationId: s02.id });
    const [box] = await newContainers('CAJA', { parentContainerId: pallet!.id });
    const [tray] = await newContainers('BANDEJA', { parentContainerId: box!.id });
    const dest = await newLocation('ALM-A-DESTINO1', 'POSICION', zona.id);

    const lines = async () => (await pool.query(`SELECT count(*)::int AS n FROM stock_movement_line`)).rows[0].n;
    const before = await lines();

    const res = await call('POST', `/api/containers/${pallet!.id}/move`, usuario, { toLocationId: dest.id, reason: 'FICTICIO reorganización' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ descendantsMoved: 2, destination: 'ALM-A-DESTINO1' });
    expect(await lines()).toBe(before + 1); // una sola línea de movimiento

    for (const id of [pallet!.id, box!.id, tray!.id]) {
      expect((await detail(id)).locationPath.at(-1).code).toBe('ALM-A-DESTINO1');
    }
    // La bandeja sigue dentro de la caja, y la caja dentro del palet.
    expect((await detail(tray!.id)).containerPath.map((c: { code: string }) => c.code)).toEqual([pallet!.code, box!.code, tray!.code]);

    const history = (await detail(pallet!.id)).movements;
    expect(history[0]).toMatchObject({
      movementType: 'CONTAINER_MOVE', fromLocation: 'ALM-A-P01-E01-N02-S02', toLocation: 'ALM-A-DESTINO1',
      performedBy: 'FICTICIO Usuario Estándar', reason: 'FICTICIO reorganización',
    });
    expect(history.at(-1)).toMatchObject({ fromLocation: null, toLocation: 'ALM-A-P01-E01-N02-S02', reason: 'Alta del contenedor' });
  });

  it('extraer una caja de un palet la desvincula y le da ubicación propia', async () => {
    const [pallet] = await newContainers('PALET', { locationId: s02.id });
    const [box] = await newContainers('CAJA', { parentContainerId: pallet!.id });

    const res = await call('POST', `/api/containers/${box!.id}/move`, usuario, { toLocationId: armario.id });
    expect(res.statusCode).toBe(200);
    const b = await detail(box!.id);
    expect(b.container.parentContainerId).toBeNull();
    expect(b.containerPath).toHaveLength(1);
    expect(b.locationPath.map((l: { code: string }) => l.code)).toEqual(['COM', 'COM-ARM-01']);
    expect(b.movements[0]).toMatchObject({ fromContainer: pallet!.code, toLocation: 'COM-ARM-01' });
    expect((await detail(pallet!.id)).children).toHaveLength(0);

    // Y se puede volver a meter en otro contenedor.
    const [other] = await newContainers('PALET', { locationId: s02.id });
    expect((await call('POST', `/api/containers/${box!.id}/move`, usuario, { toParentContainerId: other!.id })).statusCode).toBe(200);
    expect((await detail(box!.id)).locationPath.at(-1).code).toBe('ALM-A-P01-E01-N02-S02');
  });

  it('un contenedor no puede meterse dentro de sí mismo ni de algo que lleva dentro', async () => {
    const [pallet] = await newContainers('PALET', { locationId: s02.id });
    const [box] = await newContainers('CAJA', { parentContainerId: pallet!.id });
    const [tray] = await newContainers('BANDEJA', { parentContainerId: box!.id });
    for (const target of [pallet!.id, box!.id, tray!.id]) {
      const res = await call('POST', `/api/containers/${pallet!.id}/move`, usuario, { toParentContainerId: target });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('CONTENEDOR_CICLICO');
    }
  });

  it('rechaza destinos inexistentes, dobles o iguales al sitio actual', async () => {
    const [box] = await newContainers('CAJA', { locationId: s02.id });
    const move = (payload: unknown) => call('POST', `/api/containers/${box!.id}/move`, usuario, payload);
    expect((await move({})).statusCode).toBe(400);
    expect((await move({ toLocationId: s02.id, toParentContainerId: box!.id })).statusCode).toBe(400);
    expect((await move({ toLocationId: randomUUID() })).statusCode).toBe(400);
    const same = await move({ toLocationId: s02.id });
    expect(same.statusCode).toBe(409);
    expect(same.json().error.code).toBe('MISMO_LUGAR');
  });

  it('reenviar un movimiento con la misma clave no lo registra dos veces (escenario 16)', async () => {
    const [box] = await newContainers('CAJA', { locationId: s02.id });
    const key = randomUUID();
    const first = await call('POST', `/api/containers/${box!.id}/move`, usuario, { toLocationId: armario.id }, key);
    const second = await call('POST', `/api/containers/${box!.id}/move`, usuario, { toLocationId: armario.id }, key);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.headers['idempotent-replay']).toBe('true');
    expect(second.json().movementNumber).toBe(first.json().movementNumber);
    expect((await detail(box!.id)).movements).toHaveLength(2); // alta + un único traslado
  });

  it('el usuario de consulta puede ver, pero no mover', async () => {
    const [box] = await newContainers('CAJA', { locationId: s02.id });
    expect((await call('GET', `/api/containers/${box!.id}`, consulta)).statusCode).toBe(200);
    expect((await call('POST', `/api/containers/${box!.id}/move`, consulta, { toLocationId: armario.id })).statusCode).toBe(403);
    expect((await detail(box!.id)).locationPath.at(-1).code).toBe('ALM-A-P01-E01-N02-S02');
  });

  it('la capacidad superada avisa y deja continuar si se confirma', async () => {
    const small = await newLocation('ALM-A-PEQUENA', 'POSICION', zona.id, { maxCapacity: 2 });
    await newContainers('CAJA', { locationId: small.id }, 2);
    const [extra] = await newContainers('CAJA', { locationId: s02.id });

    const warned = await call('POST', `/api/containers/${extra!.id}/move`, usuario, { toLocationId: small.id });
    expect(warned.statusCode).toBe(409);
    expect(warned.json().error).toMatchObject({ code: 'CAPACIDAD_SUPERADA' });
    expect(warned.json().error.message).toContain('admite 2 contenedores y ya tiene 2');
    expect((await detail(extra!.id)).locationPath.at(-1).code).toBe('ALM-A-P01-E01-N02-S02');

    const forced = await call('POST', `/api/containers/${extra!.id}/move`, usuario, { toLocationId: small.id, force: true });
    expect(forced.statusCode).toBe(200);

    // Con la política en BLOCK ya no se puede forzar.
    await pool.query(`UPDATE system_parameter SET value = '"BLOCK"' WHERE key = 'capacity.policy'`);
    const [another] = await newContainers('CAJA', { locationId: s02.id });
    const blocked = await call('POST', `/api/containers/${another!.id}/move`, usuario, { toLocationId: small.id, force: true });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('CAPACIDAD_BLOQUEADA');
    await pool.query(`UPDATE system_parameter SET value = '"WARN"' WHERE key = 'capacity.policy'`);
  });

  it('cada movimiento queda en la auditoría', async () => {
    const res = await call('GET', '/api/admin/audit?limit=200', almacen);
    const actions = new Set((res.json().entries as Array<{ action: string }>).map((e) => e.action));
    for (const a of ['ubicacion.alta', 'contenedor.alta', 'contenedor.movimiento', 'tipo_contenedor.alta']) {
      expect(actions).toContain(a);
    }
  });
});

describe('retirada de contenedores', () => {
  it('solo se retira un contenedor vacío; conserva su historial y su QR', async () => {
    const [pallet] = await newContainers('PALET', { locationId: s02.id });
    const [box] = await newContainers('CAJA', { parentContainerId: pallet!.id });

    const notEmpty = await call('POST', `/api/containers/${pallet!.id}/retire`, almacen, {});
    expect(notEmpty.statusCode).toBe(409);
    expect(notEmpty.json().error.code).toBe('CONTENEDOR_NO_VACIO');
    expect((await call('POST', `/api/containers/${box!.id}/retire`, usuario, {})).statusCode).toBe(403);

    const retired = await call('POST', `/api/containers/${box!.id}/retire`, almacen, { reason: 'FICTICIO caja rota' });
    expect(retired.statusCode).toBe(200);
    const d = retired.json();
    expect(d.container).toMatchObject({ status: 'RETIRED', qrToken: box!.qrToken, locationId: null, parentContainerId: null });
    expect(d.container.retiredAt).not.toBeNull();
    expect(d.movements).toHaveLength(2);
    expect(d.movements[0]).toMatchObject({ fromContainer: pallet!.code, toLocation: null, reason: 'FICTICIO caja rota' });

    // Retirado: ni se mueve ni admite nada dentro, pero su QR sigue identificándolo.
    expect((await call('POST', `/api/containers/${box!.id}/move`, usuario, { toLocationId: s02.id })).statusCode).toBe(409);
    expect((await call('POST', '/api/containers', almacen, { typeCode: 'CAJA', parentContainerId: box!.id })).statusCode).toBe(409);
    expect((await call('GET', `/api/scan/${box!.qrToken}`, consulta)).json()).toMatchObject({ kind: 'container', id: box!.id });
    // Y deja de aparecer en el palet y en los listados por defecto.
    expect((await detail(pallet!.id)).children).toHaveLength(0);
    const list = (await call('GET', `/api/containers?q=${box!.code}`, consulta)).json().containers;
    expect(list).toHaveLength(0);
  });
});

describe('escaneo', () => {
  it('el QR de un contenedor o de una ubicación dice qué es', async () => {
    const [pallet] = await newContainers('PALET', { locationId: s01.id });
    expect((await call('GET', `/api/scan/${pallet!.qrToken}`, consulta)).json()).toEqual({
      kind: 'container', id: pallet!.id, code: pallet!.code, name: null,
    });
    expect((await call('GET', `/api/scan/${s01.qrToken}`, consulta)).json()).toMatchObject({
      kind: 'location', id: s01.id, code: 'ALM-A-P01-E01-N02-S01',
    });
  });

  it('también admite el código legible tecleado a mano, en mayúsculas o minúsculas', async () => {
    const [pallet] = await newContainers('PALET', { locationId: s01.id });
    expect((await call('GET', `/api/scan/${pallet!.code.toLowerCase()}`, consulta)).json().id).toBe(pallet!.id);
    expect((await call('GET', '/api/scan/com-arm-01', consulta)).json()).toMatchObject({ kind: 'location', id: armario.id });
  });

  it('un código desconocido devuelve un error claro, y sin sesión no se resuelve nada', async () => {
    const res = await call('GET', '/api/scan/NOEXISTE123', consulta);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.message).toContain('no corresponde a nada');
    expect((await app.inject({ method: 'GET', url: `/api/scan/${s01.qrToken}` })).statusCode).toBe(401);
  });

  it('el QR no contiene la ubicación ni el contenido: sigue valiendo tras mover el contenedor', async () => {
    const [box] = await newContainers('CAJA', { locationId: s01.id });
    await call('POST', `/api/containers/${box!.id}/move`, usuario, { toLocationId: armario.id });
    const hit = (await call('GET', `/api/scan/${box!.qrToken}`, consulta)).json();
    expect(hit.id).toBe(box!.id);
    expect(box!.qrToken).not.toContain('COM');
    expect((await detail(hit.id)).locationPath.at(-1).code).toBe('COM-ARM-01');
  });
});
