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

const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, cookies: Cookie, payload?: unknown) =>
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
  // Las pruebas usan códigos con prefijos de una letra: P01, E01, N01, S01.
  await pool.query(
    `UPDATE location_type SET code_prefix = x.p FROM (VALUES ('PASILLO', 'P'), ('ESTANTERIA', 'E'), ('NIVEL', 'N'), ('POSICION', 'S')) AS x (c, p) WHERE code = x.c`,
  );
  await pool.query(`UPDATE app_user SET must_change_password = false`);
  // Estas pruebas guardan contenido suelto en zonas: aquí la zona hace de contenedor.
  await pool.query(`UPDATE location_type SET holds_content = true WHERE code = 'ZONA'`);
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
    expect(pasillo).toMatchObject({ code: 'ALM-H-P01', segment: 'P01', seq: 1, parentCode: 'ALM-H' });
    // El prefijo lo pone el tipo; solo se elige el número. Sin número, el siguiente libre.
    const p05 = await call('POST', '/api/locations', almacen, { seq: 5, name: 'x', typeCode: 'PASILLO', parentId: zona.id });
    expect(p05.json().location.code).toBe('ALM-H-P05');
    const next = await call('POST', '/api/locations', almacen, { name: 'x', typeCode: 'PASILLO', parentId: zona.id });
    expect(next.json().location.code).toBe('ALM-H-P06');
    const proposal = (await call('GET', `/api/locations/next-code?parentId=${zona.id}&typeCode=ESTANTERIA`, almacen)).json();
    expect(proposal).toMatchObject({ parentCode: 'ALM-H', typePrefix: 'E', seq: 1, code: 'ALM-H-E01' });
    // Un texto sin número no vale, y un número repetido tampoco.
    expect((await call('POST', '/api/locations', almacen, { segment: 'PASILLO', name: 'x', typeCode: 'PASILLO', parentId: zona.id })).json().error.code).toBe('CODIGO_NO_VALIDO');
    expect((await call('POST', '/api/locations', almacen, { seq: 1, name: 'x', typeCode: 'PASILLO', parentId: zona.id })).json().error.code).toBe('CODIGO_DUPLICADO');
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
    expect(await codeOf(n.id)).toBe('ALM-B-P01-E01-N01');
    // El QR no cambia: las etiquetas impresas siguen funcionando.
    const scan = await call('GET', `/api/scan/${(await pool.query(`SELECT qr_token FROM storage_location WHERE id = $1`, [n.id])).rows[0].qr_token}`, usuario);
    expect(scan.json().code).toBe('ALM-B-P01-E01-N01');
  });

  it('al mover una ubicación dentro de otra, ella y las suyas toman el código nuevo', async () => {
    const a = await loc('ZA', 'ZONA');
    const b = await loc('ZB', 'ZONA');
    const e = await loc('E07', 'ESTANTERIA', a.id);
    const n = await loc('N1', 'NIVEL', e.id);
    expect((await call('PATCH', `/api/locations/${e.id}`, almacen, { parentId: b.id })).statusCode).toBe(200);
    expect(await codeOf(e.id)).toBe('ZB-E07');
    expect(await codeOf(n.id)).toBe('ZB-E07-N01');
  });

  it('si el cambio choca con un código existente no se guarda nada', async () => {
    const z1 = await loc('CHOQUE-1', 'ZONA');
    await loc('CHOQUE-2', 'ZONA');
    const hija = await loc('N1', 'NIVEL', z1.id);
    const res = await call('PATCH', `/api/locations/${z1.id}`, almacen, { segment: 'CHOQUE-2' });
    expect(res.json().error.code).toBe('CODIGO_DUPLICADO');
    expect(await codeOf(hija.id)).toBe('CHOQUE-1-N01');
  });
});

describe('recodificar las ubicaciones antiguas', () => {
  it('enseña los cambios y los aplica de arriba abajo', async () => {
    const zona = await loc('VIEJA', 'ZONA');
    const est = await loc('E01', 'ESTANTERIA', zona.id);
    const niv = await loc('N1', 'NIVEL', est.id);
    // Simula una ubicación creada antes de la regla, con un código que no la sigue.
    await pool.query(`UPDATE storage_location SET code = 'ESTANTE-SUELTO' WHERE id = $1`, [est.id]);
    expect(await codeOf(niv.id)).toBe('ESTANTE-SUELTO-N01');
    const preview = (await call('GET', '/api/locations/recode-preview', usuario)).json();
    expect(preview.changes.map((c: { code: string; newCode: string }) => `${c.code} → ${c.newCode}`)).toEqual(['ESTANTE-SUELTO → VIEJA-E01', 'ESTANTE-SUELTO-N01 → VIEJA-E01-N01']);
    expect((await call('POST', '/api/locations/recode', usuario)).statusCode).toBe(403);
    const r = await call('POST', '/api/locations/recode', almacen);
    expect(r.statusCode, r.body).toBe(200);
    expect(await codeOf(est.id)).toBe('VIEJA-E01');
    expect(await codeOf(niv.id)).toBe('VIEJA-E01-N01');
    expect((await call('GET', '/api/locations/recode-preview', usuario)).json().changes).toEqual([]);
  });

  it('las existentes se descomponen al migrar: su parte final se conserva', async () => {
    const r = await pool.query(`SELECT code, segment FROM storage_location WHERE code = 'VIEJA-E01-N01'`);
    expect(r.rows[0].segment).toBe('N01');
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
    expect(await codeOf(n.id)).toBe('MULTI-E10-N01');
    const e2now = (await call('GET', `/api/locations/${e2.id}`, usuario)).json().location;
    expect(e2now).toMatchObject({ typeCode: 'ARMARIO', description: 'FICTICIO cambiado en bloque' });
  });

  it('si una fila falla no se guarda ninguna, y dice cuál', async () => {
    const z = await loc('TODO-NADA', 'ZONA');
    const a = await loc('N1', 'NIVEL', z.id);
    const b = await loc('N2', 'NIVEL', z.id);
    const res = await call('PATCH', '/api/locations/bulk', almacen, {
      items: [{ id: a.id, name: 'FICTICIO cambiado' }, { id: b.id, seq: 1 }],
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('TODO-NADA-N02');
    expect((await pool.query(`SELECT name FROM storage_location WHERE id = $1`, [a.id])).rows[0].name).toBe('FICTICIO N1');
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

describe('prefijo por tipo de ubicación', () => {
  let admin: Cookie;
  beforeAll(async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/auth/login', headers: { 'x-sga-client': 'web' },
      payload: { username: 'admin', password: config.adminPassword },
    });
    admin = { sga_session: res.cookies.find((c) => c.name === 'sga_session')!.value };
  });

  it('eliminar: solo administradores y solo si no deja huella; si no, se desactiva', async () => {
    const z = await loc('BORRA', 'ZONA');
    const e = await loc('E1', 'ESTANTERIA', z.id);
    expect((await call('DELETE', `/api/locations/${e.id}`, almacen)).statusCode).toBe(403);
    // Con algo dentro, no.
    const full = await call('DELETE', `/api/locations/${z.id}`, admin);
    expect(full.statusCode).toBe(409);
    expect(full.json().error.message).toContain('tiene 1 ubicación dentro');
    // Vacía y sin historial, sí; desaparece y queda en la auditoría.
    const ok = await call('DELETE', `/api/locations/${e.id}`, admin);
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await call('GET', `/api/locations/${e.id}`, almacen)).statusCode).toBe(404);
    const a = (await pool.query(`SELECT before_data AS before FROM audit_log WHERE action = 'ubicacion.baja' AND entity_id = $1`, [e.id])).rows[0];
    expect(a.before.codigo).toBe('BORRA-E01');
    // Con movimientos en su historial, no: hay que desactivarla.
    const fam = (await call('GET', '/api/material-families', almacen)).json().families[0].id;
    const mat = (await call('POST', '/api/materials', almacen, { description: 'FICTICIO Tornillo', familyId: fam, unitCode: 'ud' })).json().material.id;
    expect((await call('POST', '/api/stock/receipt', almacen, { materialId: mat, locationId: z.id, quantity: 2 })).statusCode).toBe(201);
    const bal = (await pool.query(`SELECT id FROM stock_balance WHERE material_id = $1`, [mat])).rows[0].id;
    expect((await call('POST', '/api/stock/withdraw', almacen, { balanceId: bal, quantity: 2 })).statusCode).toBe(200);
    const hist = await call('DELETE', `/api/locations/${z.id}`, admin);
    expect(hist.statusCode).toBe(409);
    expect(hist.json().error.code).toBe('UBICACION_CON_HISTORIAL');
    expect((await call('GET', `/api/locations/${z.id}`, almacen)).statusCode).toBe(200);
  });

  it('cambiar el prefijo de un tipo recodifica sus ubicaciones y las de dentro', async () => {
    const z = await loc('PREF', 'ZONA');
    const e = await loc('E1', 'ESTANTERIA', z.id);
    const n = await loc('N1', 'NIVEL', e.id);
    const types = (await call('GET', '/api/location-types', usuario)).json().types as Array<{ code: string; codePrefix: string }>;
    expect(types.find((t) => t.code === 'ESTANTERIA')!.codePrefix).toBe('E');
    expect((await call('PATCH', '/api/location-types/ESTANTERIA', almacen, { codePrefix: 'EST' })).statusCode).toBe(403);
    const r = await call('PATCH', '/api/location-types/ESTANTERIA', admin, { codePrefix: 'EST', name: 'Estantería metálica' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().recoded).toBeGreaterThanOrEqual(2);
    expect(await codeOf(e.id)).toBe('PREF-EST01');
    expect(await codeOf(n.id)).toBe('PREF-EST01-N01');
    // Un prefijo ya usado por otro tipo no se admite.
    expect((await call('PATCH', '/api/location-types/ESTANTERIA', admin, { codePrefix: 'N' })).json().error.code).toBe('TIPO_DUPLICADO');
    await call('PATCH', '/api/location-types/ESTANTERIA', admin, { codePrefix: 'E' });
  });

  it('cambiar el tipo de una ubicación cambia su prefijo y conserva su número', async () => {
    const z = await loc('CAMBIO-TIPO', 'ZONA');
    const e = await loc('E3', 'ESTANTERIA', z.id);
    const r = await call('PATCH', `/api/locations/${e.id}`, almacen, { typeCode: 'ARMARIO' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().location.code).toBe('CAMBIO-TIPO-ARM03');
  });

  it('cambiar el prefijo de un tipo de contenedor recodifica sus contenedores', async () => {
    const z = await loc('CONT-PREF', 'ZONA');
    const k = (await call('POST', '/api/containers', almacen, { typeCode: 'BANDEJA', locationId: z.id })).json().containers[0];
    expect(k.code).toMatch(/^BAN-\d{6}$/);
    const r = await call('PATCH', '/api/container-types/BANDEJA', admin, { codePrefix: 'BDJ' });
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().recoded).toBeGreaterThanOrEqual(1);
    const after = (await call('GET', `/api/containers/${k.id}`, usuario)).json().container;
    expect(after.code).toBe(k.code.replace('BAN-', 'BDJ-'));
    // El QR sigue llevando al mismo contenedor.
    expect((await call('GET', `/api/scan/${after.qrToken}`, usuario)).json().id).toBe(k.id);
    // Los nuevos ya salen con el prefijo nuevo.
    const k2 = (await call('POST', '/api/containers', almacen, { typeCode: 'BANDEJA', locationId: z.id })).json().containers[0];
    expect(k2.code).toMatch(/^BDJ-/);
  });

  it('solo un administrador desactiva, y la desactivada sigue viéndose', async () => {
    const z = await loc('DESACT', 'ZONA');
    const e = await loc('E1', 'ESTANTERIA', z.id);
    expect((await call('PATCH', `/api/locations/${e.id}`, almacen, { active: false })).statusCode).toBe(403);
    expect((await call('PATCH', '/api/locations/bulk', almacen, { items: [{ id: e.id, active: false }] })).statusCode).toBe(403);
    expect((await call('PATCH', `/api/locations/${e.id}`, admin, { active: false })).statusCode).toBe(200);
    const kids = (await call('GET', `/api/locations?parentId=${z.id}`, usuario)).json().locations;
    expect(kids).toMatchObject([{ id: e.id, active: false }]);
    const tree = (await call('GET', '/api/tree', usuario)).json().locations as Array<{ id: string; active: boolean }>;
    expect(tree.find((l) => l.id === e.id)?.active).toBe(false);
    expect((await call('PATCH', `/api/locations/${e.id}`, admin, { active: true })).statusCode).toBe(200);
  });

  it('las antiguas reciben prefijo de su tipo conservando su número', async () => {
    await pool.query(`UPDATE location_type SET code_prefix = 'PAS' WHERE code = 'PASILLO'`);
    const z = await loc('ANTIGUA', 'ZONA');
    // Una antigua sin número (como las creadas antes de esta versión).
    await pool.query(
      `INSERT INTO storage_location (qr_token, segment, name, parent_id, location_type_id)
       SELECT 'fic-antigua-p', 'P07', 'FICTICIO', $1, id FROM location_type WHERE code = 'PASILLO'`,
      [z.id],
    );
    const plan = (await call('GET', '/api/locations/recode-preview', usuario)).json().changes as Array<{ code: string; newCode: string }>;
    expect(plan.map((p) => `${p.code} → ${p.newCode}`)).toContain('ANTIGUA-P07 → ANTIGUA-PAS07');
    expect((await call('POST', '/api/locations/recode', almacen)).statusCode).toBe(200);
    expect((await pool.query(`SELECT code, seq FROM storage_location WHERE qr_token = 'fic-antigua-p'`)).rows[0]).toEqual({ code: 'ANTIGUA-PAS07', seq: 7 });
    expect((await call('GET', '/api/locations/recode-preview', usuario)).json().changes).toEqual([]);
  });
});

describe('auditoría', () => {
  it('filtra por operación o por grupo, y pagina sin límite de 100', async () => {
    const all = (await call('GET', '/api/admin/audit?limit=1000', almacen)).json();
    expect(all.entries.length).toBeGreaterThan(20);
    const types = (await call('GET', '/api/admin/audit/actions', almacen)).json();
    expect(types.actions.map((a: { action: string }) => a.action)).toContain('ubicacion.alta');
    const altas = (await call('GET', '/api/admin/audit?action=ubicacion.alta', almacen)).json().entries as Array<{ action: string }>;
    expect(altas.length).toBeGreaterThan(5);
    expect(new Set(altas.map((e) => e.action))).toEqual(new Set(['ubicacion.alta']));
    const grupo = (await call('GET', '/api/admin/audit?action=ubicacion.', almacen)).json().entries as Array<{ action: string }>;
    expect(grupo.every((e) => e.action.startsWith('ubicacion.'))).toBe(true);
    expect(grupo.length).toBeGreaterThan(altas.length);
    // Páginas: 5 y luego las 5 siguientes, sin repetir.
    const p1 = (await call('GET', '/api/admin/audit?limit=5', almacen)).json();
    expect(p1.more).toBe(true);
    const p2 = (await call('GET', `/api/admin/audit?limit=5&before=${p1.entries[4].id}`, almacen)).json();
    expect(p2.entries[0].id).toBeLessThan(p1.entries[4].id);
    // Búsqueda dentro de lo registrado.
    const busq = (await call('GET', '/api/admin/audit?q=MULTI-E10', almacen)).json().entries;
    expect(busq.length).toBeGreaterThan(0);
    expect((await call('GET', '/api/admin/audit', usuario)).statusCode).toBe(403);
  });
});

describe('el contenido va siempre en un contenedor', () => {
  let admin: Cookie;
  beforeAll(async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/auth/login', headers: { 'x-sga-client': 'web' },
      payload: { username: 'admin', password: config.adminPassword },
    });
    admin = { sga_session: res.cookies.find((c) => c.name === 'sga_session')!.value };
  });
  it('solo los muebles (armario, cajonera, cajón) guardan contenido directamente', async () => {
    const types = (await call('GET', '/api/location-types', almacen)).json().types;
    expect(types.filter((t: { holdsContent: boolean }) => t.holdsContent).map((t: { code: string }) => t.code).sort()).toEqual(['ARMARIO', 'CAJON', 'CAJONERA', 'ZONA']);
    const z = await loc('CONT', 'ZONA');
    const est = await loc('E1', 'ESTANTERIA', z.id);
    const arm = await loc('A1', 'ARMARIO', z.id);
    const fam = (await call('GET', '/api/material-families', almacen)).json().families[0].id;
    const mat = (await call('POST', '/api/materials', almacen, { description: 'FICTICIO Arandela', familyId: fam, unitCode: 'ud' })).json().material.id;
    const no = await call('POST', '/api/stock/receipt', almacen, { materialId: mat, locationId: est.id, quantity: 5 });
    expect(no.statusCode).toBe(409);
    expect(no.json().error.code).toBe('SOLO_CONTENEDORES');
    expect(no.json().error.message).toContain('solo aloja contenedores');
    expect((await call('POST', '/api/stock/receipt', almacen, { materialId: mat, locationId: arm.id, quantity: 5 })).statusCode).toBe(201);
    // Se puede cambiar en Tipos.
    expect((await call('PATCH', '/api/location-types/ESTANTERIA', admin, { holdsContent: true })).statusCode).toBe(200);
    expect((await call('POST', '/api/stock/receipt', almacen, { materialId: mat, locationId: est.id, quantity: 2 })).statusCode).toBe(201);
    // Un estimado también: al meterlo en la caja no deja una línea a cero suelta.
    const est2 = (await call('POST', '/api/materials', almacen, { description: 'FICTICIO Bridas', familyId: fam, unitCode: 'ud', quantityTracking: 'ESTIMATED' })).json().material.id;
    expect((await call('POST', '/api/stock/receipt', almacen, { materialId: est2, locationId: est.id, quantity: 50 })).statusCode).toBe(201);
    await call('PATCH', '/api/location-types/ESTANTERIA', admin, { holdsContent: false });
    // Lo que quedó suelto se avisa y se mete en una caja nueva con un botón.
    const d = (await call('GET', `/api/locations/${est.id}`, almacen)).json().location;
    expect(d).toMatchObject({ holdsContent: false, looseLines: 2 });
    const box = await call('POST', `/api/locations/${est.id}/box-loose`, almacen, {});
    expect(box.statusCode, box.body).toBe(200);
    expect(box.json().code).toMatch(/^CAJ-/);
    const inBox = (await pool.query(`SELECT quantity::float AS q FROM stock_balance WHERE container_id = $1 ORDER BY quantity`, [box.json().containerId])).rows;
    expect(inBox).toEqual([{ q: 2 }, { q: 50 }]);
    expect((await call('GET', `/api/locations/${est.id}`, almacen)).json().location.looseLines).toBe(0);
  });

  it('cada tipo de ubicación puede limitar qué contenedores admite', async () => {
    const z = await loc('PALETS', 'ZONA');
    const ok = await call('PATCH', '/api/location-types/AREA', admin, { allowedContainerTypes: ['PALET'] });
    expect(ok.statusCode, ok.body).toBe(200);
    const area = await loc('AR1', 'AREA', z.id);
    const caja = await call('POST', '/api/containers', almacen, { typeCode: 'CAJA', locationId: area.id });
    expect(caja.statusCode).toBe(409);
    expect(caja.json().error.message).toContain('no caben contenedores de tipo Caja');
    expect((await call('POST', '/api/containers', almacen, { typeCode: 'PALET', locationId: area.id })).statusCode).toBe(201);
    // Mover una caja ahí tampoco se deja.
    const otra = (await call('POST', '/api/containers', almacen, { typeCode: 'CAJA', locationId: z.id })).json().containers[0].id;
    expect((await call('POST', `/api/containers/${otra}/move`, almacen, { toLocationId: area.id })).statusCode).toBe(409);
    expect((await call('GET', '/api/location-types', almacen)).json().types.find((t: { code: string }) => t.code === 'AREA').allowedContainerTypes).toEqual(['PALET']);
    await call('PATCH', '/api/location-types/AREA', admin, { allowedContainerTypes: [] });
  });
});
