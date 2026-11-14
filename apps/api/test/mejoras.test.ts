/**
 * Pruebas de las mejoras tras la Fase 2: duplicar ubicaciones y contenedores,
 * y exportar a Excel. Datos ficticios sobre un PostgreSQL real.
 */
import { randomUUID } from 'node:crypto';
import ExcelJS from 'exceljs';
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
let consulta: Cookie;

async function sessionOf(username: string): Promise<Cookie> {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/login', headers: { 'x-sga-client': 'web' }, payload: { username, password: DEMO_PASSWORD },
  });
  return { sga_session: res.cookies.find((c) => c.name === 'sga_session')!.value };
}

const call = (method: 'GET' | 'POST', path: string, cookies: Cookie, payload?: unknown, key: string = randomUUID()) =>
  app.inject({
    method, url: path, cookies, payload: payload as never,
    headers: { 'x-sga-client': 'web', ...(method === 'POST' ? { 'idempotency-key': key } : {}) },
  });

async function newLocation(code: string, typeCode: string, parentId?: string, extra: Record<string, unknown> = {}) {
  const res = await call('POST', '/api/locations', almacen, { code, name: `FICTICIO ${code}`, typeCode, parentId, ...extra });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().location as { id: string; code: string; qrToken: string };
}

async function newContainers(typeCode: string, where: Record<string, string>, quantity = 1) {
  const res = await call('POST', '/api/containers', almacen, { typeCode, quantity, ...where });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().containers as Array<{ id: string; code: string; qrToken: string }>;
}

const codesUnder = async (parentId: string) =>
  (
    await pool.query(
      `WITH RECURSIVE down AS (
         SELECT id, code FROM storage_location WHERE parent_id = $1
         UNION ALL SELECT l.id, l.code FROM storage_location l JOIN down ON l.parent_id = down.id)
       SELECT code FROM down ORDER BY code`,
      [parentId],
    )
  ).rows.map((r) => r.code as string);

let pasillo: { id: string };
let e01: { id: string; code: string; qrToken: string };

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
  [almacen, usuario, consulta] = await Promise.all([sessionOf('demo.almacen'), sessionOf('demo.usuario'), sessionOf('demo.consulta')]);

  // Estantería con 2 niveles y 3 posiciones por nivel.
  const zona = await newLocation('ALM-A', 'ZONA');
  pasillo = await newLocation('ALM-A-P01', 'PASILLO', zona.id);
  e01 = await newLocation('ALM-A-P01-E01', 'ESTANTERIA', pasillo.id, { maxCapacity: 6, allowedHazardClasses: ['LIQUIDO'] });
  for (const n of ['N01', 'N02']) {
    const nivel = await newLocation(`ALM-A-P01-E01-${n}`, 'NIVEL', e01.id);
    for (const s of ['S01', 'S02', 'S03']) await newLocation(`ALM-A-P01-E01-${n}-${s}`, 'POSICION', nivel.id);
  }
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('duplicar ubicaciones', () => {
  it('propone el siguiente código libre y avisa de cuántas hay dentro', async () => {
    const res = await call('GET', `/api/locations/${e01.id}/duplicate-proposal`, almacen);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      code: 'ALM-A-P01-E02', prefix: 'ALM-A-P01', segment: 'E02', name: 'FICTICIO ALM-A-P01-E02', descendantCount: 8,
      childrenCopyable: true, blockingChildCode: null,
    });
  });

  it('sin lo de dentro: crea una sola ubicación igual, en el mismo sitio y con QR nuevo', async () => {
    const res = await call('POST', `/api/locations/${e01.id}/duplicate`, almacen, { code: 'ALM-A-P01-E02', name: 'FICTICIO Estantería 2' });
    expect(res.statusCode, res.body).toBe(201);
    const { location, created } = res.json();
    expect(created).toBe(1);
    expect(location).toMatchObject({
      code: 'ALM-A-P01-E02', name: 'FICTICIO Estantería 2', parentId: pasillo.id, typeCode: 'ESTANTERIA',
      maxCapacity: 6, allowedHazardClasses: ['LIQUIDO'], childCount: 0,
    });
    expect(location.qrToken).not.toBe(e01.qrToken);

    // La propuesta siguiente salta el código ya ocupado.
    expect((await call('GET', `/api/locations/${e01.id}/duplicate-proposal`, almacen)).json().code).toBe('ALM-A-P01-E03');
  });

  it('con lo de dentro: copia niveles y posiciones cambiando el comienzo del código', async () => {
    const res = await call('POST', `/api/locations/${e01.id}/duplicate`, almacen, {
      code: 'ALM-A-P01-E03', name: 'FICTICIO Estantería 3', includeChildren: true,
    });
    expect(res.statusCode, res.body).toBe(201);
    const { location, created } = res.json();
    expect(created).toBe(9);
    expect(await codesUnder(location.id)).toEqual([
      'ALM-A-P01-E03-N01', 'ALM-A-P01-E03-N01-S01', 'ALM-A-P01-E03-N01-S02', 'ALM-A-P01-E03-N01-S03',
      'ALM-A-P01-E03-N02', 'ALM-A-P01-E03-N02-S01', 'ALM-A-P01-E03-N02-S02', 'ALM-A-P01-E03-N02-S03',
    ]);
    // La estructura es la misma: cada posición cuelga de su nivel.
    const s = await pool.query(
      `SELECT p.code AS parent FROM storage_location l JOIN storage_location p ON p.id = l.parent_id WHERE l.code = 'ALM-A-P01-E03-N02-S03'`,
    );
    expect(s.rows[0].parent).toBe('ALM-A-P01-E03-N02');
    // Todos con QR propio.
    const tokens = await pool.query(`SELECT count(DISTINCT qr_token)::int AS n, count(*)::int AS total FROM storage_location`);
    expect(tokens.rows[0].n).toBe(tokens.rows[0].total);
    // El original no cambia.
    expect(await codesUnder(e01.id)).toHaveLength(8);
  });

  it('no crea nada si algún código de la copia ya existe', async () => {
    await newLocation('ALM-A-P01-E04-N02', 'NIVEL', pasillo.id); // choca con la futura copia
    const before = (await pool.query(`SELECT count(*)::int AS n FROM storage_location`)).rows[0].n;
    const res = await call('POST', `/api/locations/${e01.id}/duplicate`, almacen, {
      code: 'ALM-A-P01-E04', name: 'FICTICIO', includeChildren: true,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('ALM-A-P01-E04-N02');
    expect((await pool.query(`SELECT count(*)::int AS n FROM storage_location`)).rows[0].n).toBe(before);
  });

  it('lo de dentro hereda el código de la copia', async () => {
    const armario = await newLocation('COM-ARM-01', 'ARMARIO');
    await newLocation('COM-ARM-01-C01', 'CAJON', armario.id);
    const proposal = (await call('GET', `/api/locations/${armario.id}/duplicate-proposal`, almacen)).json();
    expect(proposal).toMatchObject({ code: 'COM-ARM-02', prefix: null, segment: 'COM-ARM-02', childrenCopyable: true });
    const res = await call('POST', `/api/locations/${armario.id}/duplicate`, almacen, { segment: 'COM-ARM-02', name: 'X', includeChildren: true });
    expect(res.statusCode, res.body).toBe(201);
    expect((await pool.query(`SELECT 1 FROM storage_location WHERE code = 'COM-ARM-02-C01'`)).rowCount).toBe(1);
  });

  it('reenviar el duplicado con la misma clave no crea una segunda copia', async () => {
    const key = randomUUID();
    const body = { code: 'ALM-A-P01-E09', name: 'FICTICIO', includeChildren: true };
    const a = await call('POST', `/api/locations/${e01.id}/duplicate`, almacen, body, key);
    const b = await call('POST', `/api/locations/${e01.id}/duplicate`, almacen, body, key);
    expect(a.statusCode).toBe(201);
    expect(b.headers['idempotent-replay']).toBe('true');
    expect((await pool.query(`SELECT count(*)::int AS n FROM storage_location WHERE code LIKE 'ALM-A-P01-E09%'`)).rows[0].n).toBe(9);
  });

  it('solo quien gestiona el almacén puede duplicar', async () => {
    expect((await call('GET', `/api/locations/${e01.id}/duplicate-proposal`, usuario)).statusCode).toBe(403);
    expect((await call('POST', `/api/locations/${e01.id}/duplicate`, usuario, { code: 'ALM-X', name: 'X' })).statusCode).toBe(403);
  });
});

describe('duplicar contenedores', () => {
  it('crea varias copias con código y QR propios, en el mismo sitio y con los mismos datos', async () => {
    const shelf = await newLocation('ALM-A-P01-DUP1', 'POSICION', pasillo.id);
    const [pallet] = await newContainers('PALET', { locationId: shelf.id });
    await app.inject({
      method: 'PATCH', url: `/api/containers/${pallet!.id}`, cookies: almacen,
      headers: { 'x-sga-client': 'web' }, payload: { description: 'FICTICIO chapa', reusePolicy: 'DISPOSABLE' },
    });

    const res = await call('POST', `/api/containers/${pallet!.id}/duplicate`, almacen, { quantity: 3 });
    expect(res.statusCode, res.body).toBe(201);
    const copies = res.json().containers;
    expect(copies).toHaveLength(3);
    const n = Number(pallet!.code.slice(4));
    expect(copies.map((c: { code: string }) => c.code)).toEqual([1, 2, 3].map((i) => `PAL-${String(n + i).padStart(6, '0')}`));
    for (const c of copies) {
      expect(c).toMatchObject({ locationId: shelf.id, description: 'FICTICIO chapa', reusePolicy: 'DISPOSABLE', typeCode: 'PALET' });
      expect(c.qrToken).not.toBe(pallet!.qrToken);
    }
  });

  it('con lo de dentro reproduce las cajas y bandejas, vacías y bien anidadas', async () => {
    const shelf = await newLocation('ALM-A-P01-DUP2', 'POSICION', pasillo.id);
    const [pallet] = await newContainers('PALET', { locationId: shelf.id });
    const boxes = await newContainers('CAJA', { parentContainerId: pallet!.id }, 2);
    await newContainers('BANDEJA', { parentContainerId: boxes[0]!.id });

    const res = await call('POST', `/api/containers/${pallet!.id}/duplicate`, almacen, { quantity: 2, includeChildren: true });
    expect(res.statusCode, res.body).toBe(201);
    for (const copy of res.json().containers) {
      const d = (await call('GET', `/api/containers/${copy.id}`, consulta)).json();
      expect(d.children.map((k: { typeCode: string }) => k.typeCode)).toEqual(['CAJA', 'CAJA']);
      expect(d.content).toEqual([]);
      const inner = await pool.query(
        `SELECT count(*)::int AS n FROM container k JOIN container b ON b.id = k.parent_container_id WHERE b.parent_container_id = $1`,
        [copy.id],
      );
      expect(inner.rows[0].n).toBe(1); // la bandeja dentro de la primera caja
      expect(d.locationPath.at(-1).code).toBe('ALM-A-P01-DUP2');
    }
    // El original sigue igual.
    expect((await call('GET', `/api/containers/${pallet!.id}`, consulta)).json().children).toHaveLength(2);
  });

  it('respeta la capacidad: avisa y deja continuar si se confirma', async () => {
    const small = await newLocation('ALM-A-P01-DUP3', 'POSICION', pasillo.id, { maxCapacity: 2 });
    const [box] = await newContainers('CAJA', { locationId: small.id });
    const warned = await call('POST', `/api/containers/${box!.id}/duplicate`, almacen, { quantity: 2 });
    expect(warned.statusCode).toBe(409);
    expect(warned.json().error.code).toBe('CAPACIDAD_SUPERADA');
    const forced = await call('POST', `/api/containers/${box!.id}/duplicate`, almacen, { quantity: 2, force: true });
    expect(forced.statusCode).toBe(201);
  });

  it('no duplica contenedores retirados ni lo permite a quien no gestiona', async () => {
    const shelf = await newLocation('ALM-A-P01-DUP4', 'POSICION', pasillo.id);
    const [box] = await newContainers('CAJA', { locationId: shelf.id });
    expect((await call('POST', `/api/containers/${box!.id}/duplicate`, usuario, {})).statusCode).toBe(403);
    await call('POST', `/api/containers/${box!.id}/retire`, almacen, {});
    expect((await call('POST', `/api/containers/${box!.id}/duplicate`, almacen, {})).statusCode).toBe(409);
  });
});

describe('exportar a Excel', () => {
  async function read(path: string, cookie: Cookie) {
    const res = await call('GET', path, cookie);
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml');
    expect(res.headers['content-disposition']).toMatch(/attachment; filename=".+\.xlsx"/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
    const ws = wb.worksheets[0]!;
    const rows: unknown[][] = [];
    ws.eachRow((row) => rows.push((row.values as unknown[]).slice(1)));
    return rows;
  }

  it('las ubicaciones salen con su ruta completa, ordenadas como el árbol', async () => {
    const rows = await read('/api/export/ubicaciones.xlsx', consulta);
    expect(rows[0]!.slice(0, 5)).toEqual(['Código', 'Nombre', 'Tipo', 'Ubicación superior', 'Ruta completa']);
    const s = rows.find((r) => r[0] === 'ALM-A-P01-E03-N02-S03')!;
    expect(s[2]).toBe('Posición');
    expect(s[3]).toBe('ALM-A-P01-E03-N02');
    expect(s[4]).toBe('ALM-A › ALM-A-P01 › ALM-A-P01-E03 › ALM-A-P01-E03-N02 › ALM-A-P01-E03-N02-S03');
    expect(rows.length - 1).toBe((await pool.query(`SELECT count(*)::int AS n FROM storage_location`)).rows[0].n);
  });

  it('los contenedores salen con su ubicación real aunque estén dentro de otro', async () => {
    const rows = await read('/api/export/contenedores.xlsx', consulta);
    expect(rows[0]!.slice(0, 6)).toEqual(['Código', 'Tipo', 'Estado', 'Ubicación', 'Ruta completa', 'Dentro de']);
    const tray = rows.find((r) => r[1] === 'Bandeja' && r[2] === 'Activo')!;
    expect(tray[3]).toBe('ALM-A-P01-DUP2');
    expect(String(tray[5])).toMatch(/^CAJ-\d{6}$/);
    expect(rows.some((r) => r[2] === 'Retirado')).toBe(true);
    expect(rows.length - 1).toBe((await pool.query(`SELECT count(*)::int AS n FROM container`)).rows[0].n);
  });

  it('un texto que empieza por «=» se guarda como texto, no como fórmula', async () => {
    const shelf = await newLocation('ALM-A-P01-FORMULA', 'POSICION', pasillo.id);
    const [box] = await newContainers('CAJA', { locationId: shelf.id });
    await app.inject({
      method: 'PATCH', url: `/api/containers/${box!.id}`, cookies: almacen,
      headers: { 'x-sga-client': 'web' }, payload: { description: '=HYPERLINK("http://ejemplo")' },
    });
    const res = await call('GET', '/api/export/contenedores.xlsx', consulta);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.rawPayload as unknown as ArrayBuffer);
    let found = false;
    wb.worksheets[0]!.eachRow((row) => {
      if (row.getCell(1).value === box!.code) {
        found = true;
        expect(row.getCell(8).value).toBe('=HYPERLINK("http://ejemplo")');
        expect(row.getCell(8).formula).toBeUndefined();
      }
    });
    expect(found).toBe(true);
  });

  it('sin sesión no se descarga nada, y queda registrado quién exporta', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/export/ubicaciones.xlsx' })).statusCode).toBe(401);
    const audit = await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'exportacion.%'`);
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(3);
  });
});

describe('árbol del almacén', () => {
  it('devuelve todas las ubicaciones y contenedores activos con sus padres', async () => {
    const res = await call('GET', '/api/tree', consulta);
    expect(res.statusCode).toBe(200);
    const { locations, containers } = res.json() as {
      locations: Array<{ id: string; parentId: string | null; code: string; childCount: number; containerCount: number }>;
      containers: Array<{ id: string; code: string; locationId: string | null; parentContainerId: string | null }>;
    };
    const active = await pool.query(`SELECT count(*)::int AS n FROM storage_location WHERE active`);
    expect(locations).toHaveLength(active.rows[0].n);
    const e01row = locations.find((l) => l.code === 'ALM-A-P01-E01')!;
    expect(e01row).toMatchObject({ parentId: pasillo.id, childCount: 2 });
    // Cada contenedor está en una ubicación o dentro de otro contenedor de la lista.
    const ids = new Set(containers.map((c) => c.id));
    for (const c of containers) expect(Boolean(c.locationId) !== Boolean(c.parentContainerId && ids.has(c.parentContainerId))).toBe(true);
    // Los retirados no aparecen.
    const retired = await pool.query(`SELECT id FROM container WHERE status = 'RETIRED'`);
    for (const r of retired.rows) expect(ids.has(r.id)).toBe(false);
  });

  it('sin sesión no se ve nada', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/tree' })).statusCode).toBe(401);
  });
});
