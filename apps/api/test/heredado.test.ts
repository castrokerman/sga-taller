/**
 * Código de ubicación heredado de la superior, propagación al cambiarlo,
 * recodificación de las antiguas y edición de varios a la vez.
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

const call = (method: 'GET' | 'POST' | 'PATCH', path: string, cookies: Cookie, payload?: unknown) =>
  app.inject({
    method, url: path, cookies, payload: payload as never,
    headers: { 'x-sga-client': 'web', ...(method === 'POST' ? { 'idempotency-key': randomUUID() } : {}) },
  });

async function loc(segment: string, typeCode: string, parentId?: string) {
  const res = await call('POST', '/api/locations', almacen, { segment, name: `FICTICIO ${segment}`, typeCode, parentId });
  expect(res.statusCode, res.body).toBe(201);
  return res.json().location as { id: string; code: string; segment: string; parentCode: string | null };
}

const codeOf = async (id: string) => (await pool.query(`SELECT code FROM storage_location WHERE id = $1`, [id])).rows[0].code as string;

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
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('código heredado', () => {
  it('dentro de otra solo se elige la parte final; el resto lo pone la superior', async () => {
    const zona = await loc('ALM-H', 'ZONA');
    const pasillo = await loc('p01', 'PASILLO', zona.id);
    expect(pasillo).toMatchObject({ code: 'ALM-H-P01', segment: 'P01', parentCode: 'ALM-H' });
    // Con el código completo también vale, si empieza por el de la superior.
    const res = await call('POST', '/api/locations', almacen, { code: 'OTRA-P02', name: 'x', typeCode: 'PASILLO', parentId: zona.id });
    expect(res.json().error.code).toBe('CODIGO_NO_VALIDO');
    expect((await call('POST', '/api/locations', almacen, { segment: 'P 01', name: 'x', typeCode: 'PASILLO', parentId: zona.id })).statusCode).toBe(400);
    expect((await call('POST', '/api/locations', almacen, { segment: 'P01', name: 'x', typeCode: 'PASILLO', parentId: zona.id })).json().error.code).toBe('CODIGO_DUPLICADO');
  });

  it('al cambiar el código de una ubicación cambian los de todas las de dentro', async () => {
    const zona = await loc('ALM-R', 'ZONA');
    const p = await loc('P01', 'PASILLO', zona.id);
    const e = await loc('E01', 'ESTANTERIA', p.id);
    const n = await loc('N1', 'NIVEL', e.id);
    const res = await call('PATCH', `/api/locations/${zona.id}`, almacen, { segment: 'ALM-B' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().descendantsRecoded).toBe(3);
    expect(await codeOf(p.id)).toBe('ALM-B-P01');
    expect(await codeOf(e.id)).toBe('ALM-B-P01-E01');
    expect(await codeOf(n.id)).toBe('ALM-B-P01-E01-N1');
    // El QR no cambia: las etiquetas impresas siguen funcionando.
    const scan = await call('GET', `/api/scan/${(await pool.query(`SELECT qr_token FROM storage_location WHERE id = $1`, [n.id])).rows[0].qr_token}`, usuario);
    expect(scan.json().code).toBe('ALM-B-P01-E01-N1');
  });

  it('al mover una ubicación dentro de otra, ella y las suyas toman el código nuevo', async () => {
    const a = await loc('ZA', 'ZONA');
    const b = await loc('ZB', 'ZONA');
    const e = await loc('E07', 'ESTANTERIA', a.id);
    const n = await loc('N1', 'NIVEL', e.id);
    expect((await call('PATCH', `/api/locations/${e.id}`, almacen, { parentId: b.id })).statusCode).toBe(200);
    expect(await codeOf(e.id)).toBe('ZB-E07');
    expect(await codeOf(n.id)).toBe('ZB-E07-N1');
  });

  it('si el cambio choca con un código existente no se guarda nada', async () => {
    const z1 = await loc('CHOQUE-1', 'ZONA');
    await loc('CHOQUE-2', 'ZONA');
    const hija = await loc('X', 'NIVEL', z1.id);
    const res = await call('PATCH', `/api/locations/${z1.id}`, almacen, { segment: 'CHOQUE-2' });
    expect(res.json().error.code).toBe('CODIGO_DUPLICADO');
    expect(await codeOf(hija.id)).toBe('CHOQUE-1-X');
  });
});

describe('recodificar las ubicaciones antiguas', () => {
  it('enseña los cambios y los aplica de arriba abajo', async () => {
    const zona = await loc('VIEJA', 'ZONA');
    const est = await loc('E01', 'ESTANTERIA', zona.id);
    const niv = await loc('N1', 'NIVEL', est.id);
    // Simula una ubicación creada antes de la regla, con un código que no la sigue.
    await pool.query(`UPDATE storage_location SET code = 'ESTANTE-SUELTO' WHERE id = $1`, [est.id]);
    expect(await codeOf(niv.id)).toBe('ESTANTE-SUELTO-N1');
    const preview = (await call('GET', '/api/locations/recode-preview', usuario)).json();
    expect(preview.changes.map((c: { code: string; newCode: string }) => `${c.code} → ${c.newCode}`)).toEqual(['ESTANTE-SUELTO → VIEJA-E01', 'ESTANTE-SUELTO-N1 → VIEJA-E01-N1']);
    expect((await call('POST', '/api/locations/recode', usuario)).statusCode).toBe(403);
    const r = await call('POST', '/api/locations/recode', almacen);
    expect(r.statusCode, r.body).toBe(200);
    expect(await codeOf(est.id)).toBe('VIEJA-E01');
    expect(await codeOf(niv.id)).toBe('VIEJA-E01-N1');
    expect((await call('GET', '/api/locations/recode-preview', usuario)).json().changes).toEqual([]);
  });

  it('las existentes se descomponen al migrar: su parte final se conserva', async () => {
    const r = await pool.query(`SELECT code, segment FROM storage_location WHERE code = 'VIEJA-E01-N1'`);
    expect(r.rows[0].segment).toBe('N1');
  });
});

describe('editar varias ubicaciones a la vez', () => {
  it('guarda todos los cambios juntos y propaga los códigos', async () => {
    const z = await loc('MULTI', 'ZONA');
    const e1 = await loc('E01', 'ESTANTERIA', z.id);
    const e2 = await loc('E02', 'ESTANTERIA', z.id);
    const n = await loc('N1', 'NIVEL', e1.id);
    const res = await call('PATCH', '/api/locations/bulk', almacen, {
      items: [
        { id: e1.id, segment: 'E10', name: 'FICTICIO Estantería diez', maxCapacity: 12 },
        { id: e2.id, typeCode: 'ARMARIO', description: 'FICTICIO cambiado en bloque' },
      ],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().descendantsRecoded).toBe(1);
    expect(await codeOf(n.id)).toBe('MULTI-E10-N1');
    const e2now = (await call('GET', `/api/locations/${e2.id}`, usuario)).json().location;
    expect(e2now).toMatchObject({ typeCode: 'ARMARIO', description: 'FICTICIO cambiado en bloque' });
  });

  it('si una fila falla no se guarda ninguna, y dice cuál', async () => {
    const z = await loc('TODO-NADA', 'ZONA');
    const a = await loc('A1', 'NIVEL', z.id);
    const b = await loc('B1', 'NIVEL', z.id);
    const res = await call('PATCH', '/api/locations/bulk', almacen, {
      items: [{ id: a.id, name: 'FICTICIO cambiado' }, { id: b.id, segment: 'A1' }],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('TODO-NADA-B1');
    expect((await pool.query(`SELECT name FROM storage_location WHERE id = $1`, [a.id])).rows[0].name).toBe('FICTICIO A1');
  });

  it('un usuario estándar no puede', async () => {
    const z = await loc('SIN-PERMISO', 'ZONA');
    expect((await call('PATCH', '/api/locations/bulk', usuario, { items: [{ id: z.id, name: 'x' }] })).statusCode).toBe(403);
  });
});

describe('editar varios contenedores y materiales a la vez', () => {
  it('contenedores: descripción, política y responsable', async () => {
    const z = await loc('CONT-MULTI', 'ZONA');
    const r = await call('POST', '/api/containers', almacen, { typeCode: 'CAJA', locationId: z.id, quantity: 3 });
    const ids = (r.json().containers as Array<{ id: string }>).map((k) => k.id);
    const resp = (await pool.query(`SELECT id FROM app_user WHERE username = 'demo.usuario'`)).rows[0].id;
    const res = await call('PATCH', '/api/containers/bulk', almacen, {
      items: ids.map((id, i) => ({ id, description: `FICTICIO caja ${i + 1}`, reusePolicy: 'REUSABLE', responsibleUserId: resp })),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().containers.map((k: { description: string; reusePolicy: string; responsibleName: string }) => [k.description, k.reusePolicy, k.responsibleName]))
      .toEqual([1, 2, 3].map((n) => [`FICTICIO caja ${n}`, 'REUSABLE', 'FICTICIO Usuario Estándar']));
  });

  it('materiales: familia, aviso mínimo y prestable; todo o nada', async () => {
    const fam = (await call('GET', '/api/material-families', almacen)).json().families as Array<{ id: string; code: string }>;
    const torn = fam.find((f) => f.code === 'TORNILLERIA')!.id;
    const herr = fam.find((f) => f.code === 'HERRAMIENTA')!.id;
    const mk = async (description: string) =>
      (await call('POST', '/api/materials', almacen, { description, familyId: torn, unitCode: 'ud' })).json().material.id as string;
    const a = await mk('FICTICIO Llave 10');
    const b = await mk('FICTICIO Llave 12');
    const ok = await call('PATCH', '/api/materials/bulk', almacen, {
      items: [{ id: a, familyId: herr, isLoanable: true, minStock: 2 }, { id: b, familyId: herr, isLoanable: true }],
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().materials.every((m: { familyId: string; isLoanable: boolean }) => m.familyId === herr && m.isLoanable)).toBe(true);
    const bad = await call('PATCH', '/api/materials/bulk', almacen, {
      items: [{ id: a, description: 'FICTICIO cambiado' }, { id: b, unitCode: 'NO-EXISTE' }],
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.message).toMatch(/^MAT-\d{6}: /);
    expect((await pool.query(`SELECT description FROM material WHERE id = $1`, [a])).rows[0].description).toBe('FICTICIO Llave 10');
  });
});

describe('dejar un campo vacío lo deja vacío', () => {
  it('aviso de stock bajo, capacidad y responsable', async () => {
    const fam = (await call('GET', '/api/material-families', almacen)).json().families[0].id as string;
    const m = await call('POST', '/api/materials', almacen, { description: 'FICTICIO sin aviso', familyId: fam, unitCode: 'ud', minStock: null });
    expect(m.json().material.minStock).toBeNull();
    const id = m.json().material.id as string;
    expect((await call('PATCH', `/api/materials/${id}`, almacen, { minStock: 7 })).json().material.minStock).toBe(7);
    expect((await call('PATCH', `/api/materials/${id}`, almacen, { minStock: null })).json().material.minStock).toBeNull();

    const z = await loc('VACIOS', 'ZONA');
    expect((await call('PATCH', `/api/locations/${z.id}`, almacen, { maxCapacity: 5 })).json().location.maxCapacity).toBe(5);
    expect((await call('PATCH', `/api/locations/${z.id}`, almacen, { maxCapacity: null })).json().location.maxCapacity).toBeNull();

    const k = (await call('POST', '/api/containers', almacen, { typeCode: 'CAJA', locationId: z.id })).json().containers[0].id as string;
    const resp = (await pool.query(`SELECT id FROM app_user WHERE username = 'demo.usuario'`)).rows[0].id;
    expect((await call('PATCH', `/api/containers/${k}`, almacen, { responsibleUserId: resp })).json().container.responsibleUserId).toBe(resp);
    expect((await call('PATCH', `/api/containers/${k}`, almacen, { responsibleUserId: null })).json().container.responsibleUserId).toBeNull();
  });
});
