/**
 * Pruebas de la Fase 3 (inventario) sobre un PostgreSQL real, con datos ficticios.
 * Escenarios obligatorios: 1, 4, 10, 15, 16 y 18, y además familias, modos de
 * cantidad, traslados, recuentos, préstamos, permisos y exportación.
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
let admin: Cookie;

async function sessionOf(username: string, password = DEMO_PASSWORD): Promise<Cookie> {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/login', headers: { 'x-sga-client': 'web' }, payload: { username, password },
  });
  return { sga_session: res.cookies.find((c) => c.name === 'sga_session')!.value };
}

const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, cookies: Cookie, payload?: unknown, key: string = randomUUID()) =>
  app.inject({
    method, url: path, cookies, payload: payload as never,
    headers: { 'x-sga-client': 'web', ...(method === 'POST' ? { 'idempotency-key': key } : {}) },
  });

const ok = <T = Record<string, unknown>>(res: Awaited<ReturnType<typeof call>>, status = 200): T => {
  expect(res.statusCode, res.body).toBe(status);
  return res.json() as T;
};

let familyId: string;
let caja1: string;
let caja2: string;
let estanteria: string;

async function newMaterial(data: Record<string, unknown>) {
  return ok<{ material: { id: string; internalRef: string } }>(
    await call('POST', '/api/materials', almacen, { familyId, unitCode: 'ud', ...data }), 201,
  ).material;
}

const balanceOf = async (materialId: string, containerId: string) =>
  (await pool.query(`SELECT id, quantity::float AS q, needs_recount FROM stock_balance WHERE material_id = $1 AND container_id = $2`, [materialId, containerId])).rows[0] as
    | { id: string; q: number | null; needs_recount: boolean }
    | undefined;

beforeAll(async () => {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await c.end();
  await runMigrations(url);
  pool = new pg.Pool({ connectionString: url, max: 10 });
  app = await buildApp({ pool, config });
  await ensureFirstAdmin(pool, config);
  await seedDemoUsers(pool);
  await pool.query(`UPDATE app_user SET must_change_password = false`);
  [almacen, usuario, consulta] = await Promise.all([sessionOf('demo.almacen'), sessionOf('demo.usuario'), sessionOf('demo.consulta')]);
  admin = await sessionOf('admin', config.adminPassword);

  const zona = ok<{ location: { id: string } }>(await call('POST', '/api/locations', almacen, { code: 'ALM-Z', name: 'FICTICIO Zona', typeCode: 'ZONA' }), 201);
  const est = ok<{ location: { id: string } }>(
    await call('POST', '/api/locations', almacen, { code: 'ALM-Z-E01', name: 'FICTICIO Estantería', typeCode: 'ESTANTERIA', parentId: zona.location.id }), 201,
  );
  estanteria = est.location.id;
  const cajas = ok<{ containers: Array<{ id: string }> }>(
    await call('POST', '/api/containers', almacen, { typeCode: 'CAJA', locationId: estanteria, quantity: 2 }), 201,
  );
  [caja1, caja2] = cajas.containers.map((k) => k.id) as [string, string];
  const fam = ok<{ family: { id: string } }>(await call('POST', '/api/material-families', almacen, { name: 'FICTICIO Tornillería' }), 201);
  familyId = fam.family.id;
});

afterAll(async () => {
  await app.close();
  await pool.end();
});

describe('familias', () => {
  it('se crean subfamilias y se ven con su ruta', async () => {
    const sub = ok<{ family: { id: string; path: string; parentId: string } }>(
      await call('POST', '/api/material-families', almacen, { name: 'Tornillos', parentId: familyId }), 201,
    );
    expect(sub.family.path).toBe('FICTICIO Tornillería › Tornillos');
    // Un nombre repetido en el mismo nivel no se admite.
    expect((await call('POST', '/api/material-families', almacen, { name: 'tornillos', parentId: familyId })).statusCode).toBe(409);
  });

  it('una familia no puede quedar dentro de sí misma ni de una hija suya', async () => {
    const families = ok<{ families: Array<{ id: string; parentId: string | null }> }>(await call('GET', '/api/material-families', almacen)).families;
    const hija = families.find((f) => f.parentId === familyId)!;
    const res = await call('PATCH', `/api/material-families/${familyId}`, almacen, { parentId: hija.id });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SG015');
  });

  it('renombrar no afecta a los materiales; con materiales solo se desactiva', async () => {
    const m = await newMaterial({ description: 'FICTICIO Arandela M4' });
    ok(await call('PATCH', `/api/material-families/${familyId}`, almacen, { name: 'FICTICIO Tornillería y fijaciones' }));
    const detail = ok<{ material: { familyName: string } }>(await call('GET', `/api/materials/${m.id}`, almacen));
    expect(detail.material.familyName).toBe('FICTICIO Tornillería y fijaciones');
    expect((await call('DELETE', `/api/material-families/${familyId}`, almacen)).json().error.code).toBe('FAMILIA_EN_USO');
  });

  it('un usuario estándar no gestiona familias', async () => {
    expect((await call('POST', '/api/material-families', usuario, { name: 'Otra' })).statusCode).toBe(403);
  });
});

describe('materiales', () => {
  it('reciben referencia automática consecutiva y no admiten referencias repetidas', async () => {
    const a = await newMaterial({ description: 'FICTICIO Tornillo M6x20' });
    const b = await newMaterial({ description: 'FICTICIO Tornillo M6x30' });
    expect(a.internalRef).toMatch(/^MAT-\d{6}$/);
    expect(Number(b.internalRef.slice(4))).toBe(Number(a.internalRef.slice(4)) + 1);
    expect((await call('POST', '/api/materials', almacen, { familyId, unitCode: 'ud', description: 'x', internalRef: a.internalRef.toLowerCase() })).statusCode).toBe(409);
  });

  it('el usuario de consulta ve el catálogo pero no da de alta', async () => {
    expect((await call('GET', '/api/materials', consulta)).statusCode).toBe(200);
    expect((await call('POST', '/api/materials', consulta, { familyId, unitCode: 'ud', description: 'x' })).statusCode).toBe(403);
  });
});

describe('entradas y retiradas', () => {
  let tornillo: { id: string };

  it('escenario 1: recepción de 100 unidades', async () => {
    tornillo = await newMaterial({ description: 'FICTICIO Tornillo DIN 912 M8x25', minStock: 50 });
    const r = ok<{ movementNumber: number; remaining: number }>(
      await call('POST', '/api/stock/receipt', usuario, { materialId: tornillo.id, containerId: caja1, quantity: 100, externalReference: 'ALB-FICTICIO-1' }), 201,
    );
    expect(r.remaining).toBe(100);
    expect((await balanceOf(tornillo.id, caja1))!.q).toBe(100);
  });

  it('escenario 4: retirada parcial de 20 unidades, con huella de quién y para qué', async () => {
    const bal = (await balanceOf(tornillo.id, caja1))!;
    const r = ok<{ remaining: number; message: string }>(
      await call('POST', '/api/stock/withdraw', usuario, { balanceId: bal.id, quantity: 20, reason: 'FICTICIO montaje banco 3' }),
    );
    expect(r.remaining).toBe(80);
    const detail = ok<{ movements: Array<{ movementType: string; performedBy: string; reason: string; quantityDelta: number }> }>(
      await call('GET', `/api/materials/${tornillo.id}`, almacen),
    );
    expect(detail.movements[0]).toMatchObject({
      movementType: 'WITHDRAWAL', performedBy: 'FICTICIO Usuario Estándar', reason: 'FICTICIO montaje banco 3', quantityDelta: -20,
    });
  });

  it('escenario 10: no se puede retirar más de lo que hay', async () => {
    const bal = (await balanceOf(tornillo.id, caja1))!;
    const res = await call('POST', '/api/stock/withdraw', usuario, { balanceId: bal.id, quantity: 81 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('STOCK_INSUFICIENTE');
    expect((await balanceOf(tornillo.id, caja1))!.q).toBe(80);
  });

  it('las unidades no admiten decimales', async () => {
    const bal = (await balanceOf(tornillo.id, caja1))!;
    expect((await call('POST', '/api/stock/withdraw', usuario, { balanceId: bal.id, quantity: 1.5 })).json().error.code).toBe('CANTIDAD_NO_VALIDA');
  });

  it('escenario 16: repetir la misma operación no la duplica', async () => {
    const bal = (await balanceOf(tornillo.id, caja1))!;
    const key = randomUUID();
    const a = await call('POST', '/api/stock/withdraw', usuario, { balanceId: bal.id, quantity: 5 }, key);
    const b = await call('POST', '/api/stock/withdraw', usuario, { balanceId: bal.id, quantity: 5 }, key);
    expect(a.statusCode).toBe(200);
    expect(b.statusCode).toBe(200);
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(b.json().movementNumber).toBe(a.json().movementNumber);
    expect((await balanceOf(tornillo.id, caja1))!.q).toBe(75);
  });

  it('escenario 18: dos retiradas a la vez sobre el mismo stock no lo dejan en negativo', async () => {
    const bal = (await balanceOf(tornillo.id, caja1))!;
    const [a, b] = await Promise.all([
      call('POST', '/api/stock/withdraw', usuario, { balanceId: bal.id, quantity: 50 }),
      call('POST', '/api/stock/withdraw', almacen, { balanceId: bal.id, quantity: 50 }),
    ]);
    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([200, 409]);
    expect((await balanceOf(tornillo.id, caja1))!.q).toBe(25);
  });

  it('por debajo del mínimo aparece como stock bajo', async () => {
    const list = ok<{ materials: Array<{ id: string; lowStock: boolean; quantity: number }> }>(await call('GET', '/api/materials', usuario));
    expect(list.materials.find((m) => m.id === tornillo.id)).toMatchObject({ quantity: 25, lowStock: true });
  });

  it('escenario 15: un movimiento se revierte con otro y el original no se toca', async () => {
    const r = ok<{ movementNumber: number }>(
      await call('POST', '/api/stock/receipt', almacen, { materialId: tornillo.id, containerId: caja1, quantity: 10 }), 201,
    );
    const mv = (await pool.query(`SELECT id FROM stock_movement WHERE movement_number = $1`, [r.movementNumber])).rows[0];
    expect((await call('POST', `/api/stock/movements/${mv.id}/reverse`, usuario, { reason: 'Error' })).statusCode).toBe(403);
    ok(await call('POST', `/api/stock/movements/${mv.id}/reverse`, almacen, { reason: 'FICTICIO entrada duplicada' }));
    expect((await balanceOf(tornillo.id, caja1))!.q).toBe(25);
    const again = await call('POST', `/api/stock/movements/${mv.id}/reverse`, almacen, { reason: 'Otra vez' });
    expect(again.json().error.code).toBe('YA_REVERTIDO');
    // El historial es inmutable.
    await expect(pool.query(`DELETE FROM stock_movement_line WHERE movement_id = $1`, [mv.id])).rejects.toMatchObject({ code: 'SG011' });
  });

  it('una retirada que vacía un saldo exacto lo quita del contenedor y avisa si la caja es desechable', async () => {
    const m = await newMaterial({ description: 'FICTICIO Pasador 4x20' });
    ok(await call('POST', '/api/stock/receipt', usuario, { materialId: m.id, containerId: caja2, quantity: 3 }), 201);
    const bal = (await balanceOf(m.id, caja2))!;
    const r = ok<{ remaining: number; emptyDisposable: string | null }>(await call('POST', '/api/stock/withdraw', usuario, { balanceId: bal.id, quantity: 3 }));
    expect(r.remaining).toBe(0);
    expect(r.emptyDisposable).toMatch(/^CAJ-/);
    expect(await balanceOf(m.id, caja2)).toBeUndefined();
    // No se retira sola: la retirada se puede revertir.
    expect((await pool.query(`SELECT status FROM container WHERE id = $1`, [caja2])).rows[0].status).toBe('ACTIVE');
  });

  it('el usuario de consulta no retira', async () => {
    const bal = (await balanceOf(tornillo.id, caja1))!;
    expect((await call('POST', '/api/stock/withdraw', consulta, { balanceId: bal.id, quantity: 1 })).statusCode).toBe(403);
  });

  it('el administrador técnico no opera el inventario por tener ese rol', async () => {
    const bal = (await balanceOf(tornillo.id, caja1))!;
    expect((await call('POST', '/api/stock/withdraw', admin, { balanceId: bal.id, quantity: 1 })).statusCode).toBe(403);
  });
});

describe('modos de cantidad', () => {
  it('aproximado: se puede retirar hasta cero y se pide recuento', async () => {
    const m = await newMaterial({ description: 'FICTICIO Tuerca M6 a granel', quantityTracking: 'ESTIMATED' });
    ok(await call('POST', '/api/stock/receipt', usuario, { materialId: m.id, containerId: caja1, quantity: 30 }), 201);
    const bal = (await balanceOf(m.id, caja1))!;
    const r = ok<{ remaining: number; needsRecount: boolean; message: string }>(
      await call('POST', '/api/stock/withdraw', usuario, { balanceId: bal.id, quantity: 40 }),
    );
    expect(r).toMatchObject({ remaining: 0, needsRecount: true });
    expect(r.message).toContain('conviene recontar');
    expect(await balanceOf(m.id, caja1)).toMatchObject({ q: 0, needs_recount: true });
  });

  it('sin contar: solo presencia; se registra quién retira y se puede marcar como agotado', async () => {
    const m = await newMaterial({ description: 'FICTICIO Bridas de plástico', quantityTracking: 'NOT_TRACKED' });
    ok(await call('POST', '/api/stock/receipt', usuario, { materialId: m.id, containerId: caja1 }), 201);
    const bal = (await balanceOf(m.id, caja1))!;
    expect(bal.q).toBeNull();
    ok(await call('POST', '/api/stock/withdraw', usuario, { balanceId: bal.id }));
    expect(await balanceOf(m.id, caja1)).toBeDefined();
    ok(await call('POST', '/api/stock/withdraw', usuario, { balanceId: bal.id, exhausted: true }));
    expect(await balanceOf(m.id, caja1)).toBeUndefined();
  });

  it('con lote: la entrada exige lote', async () => {
    const m = await newMaterial({ description: 'FICTICIO Barra 6082 Ø30', unitCode: 'm', lotTracked: true });
    expect((await call('POST', '/api/stock/receipt', usuario, { materialId: m.id, containerId: caja1, quantity: 6 })).json().error.code).toBe('FALTA_LOTE');
    ok(await call('POST', '/api/stock/receipt', usuario, { materialId: m.id, containerId: caja1, quantity: 6.25, lotCode: 'COLADA-F1' }), 201);
    expect((await balanceOf(m.id, caja1))!.q).toBe(6.25);
  });
});

describe('traslados y recuentos', () => {
  it('traslada parte del material a otro contenedor o directamente a una ubicación', async () => {
    const m = await newMaterial({ description: 'FICTICIO Remache 4,8' });
    ok(await call('POST', '/api/stock/receipt', usuario, { materialId: m.id, containerId: caja1, quantity: 50 }), 201);
    const bal = (await balanceOf(m.id, caja1))!;
    ok(await call('POST', '/api/stock/transfer', usuario, { balanceId: bal.id, quantity: 20, toContainerId: caja2 }));
    ok(await call('POST', '/api/stock/transfer', usuario, { balanceId: bal.id, quantity: 10, toLocationId: estanteria }));
    expect((await balanceOf(m.id, caja1))!.q).toBe(20);
    expect((await balanceOf(m.id, caja2))!.q).toBe(20);
    const atShelf = ok<{ stock: Array<{ materialId: string; quantity: number }> }>(await call('GET', `/api/stock?locationId=${estanteria}`, usuario));
    expect(atShelf.stock.find((s) => s.materialId === m.id)?.quantity).toBe(10);
  });

  it('el recuento corrige la diferencia y lo hace solo un responsable', async () => {
    const m = await newMaterial({ description: 'FICTICIO Tornillo M5x10', quantityTracking: 'ESTIMATED' });
    ok(await call('POST', '/api/stock/receipt', usuario, { materialId: m.id, containerId: caja2, quantity: 300 }), 201);
    const bal = (await balanceOf(m.id, caja2))!;
    expect((await call('POST', '/api/stock/count', usuario, { balanceId: bal.id, counted: 280 })).statusCode).toBe(403);
    const r = ok<{ remaining: number; message: string }>(await call('POST', '/api/stock/count', almacen, { balanceId: bal.id, counted: 280 }));
    expect(r.remaining).toBe(280);
    expect(r.message).toContain('-20');
    const line = (await pool.query(
      `SELECT quantity_delta::float AS d FROM stock_movement_line ml JOIN stock_movement mv ON mv.id = ml.movement_id
        WHERE ml.material_id = $1 AND mv.movement_type = 'COUNT'`, [m.id])).rows[0];
    expect(line.d).toBe(-20);
  });
});

describe('material restringido', () => {
  it('lo restringido a un proyecto no se retira sin autorización', async () => {
    const m = await newMaterial({ description: 'FICTICIO Perfil restringido' });
    ok(await call('POST', '/api/stock/receipt', almacen, { materialId: m.id, containerId: caja1, quantity: 10 }), 201);
    const bal = (await balanceOf(m.id, caja1))!;
    const resp = (await pool.query(`SELECT id FROM app_user WHERE username = 'demo.proyecto'`)).rows[0].id;
    const p = await pool.query(`INSERT INTO project (code, name, responsible_user_id) VALUES ('FIC-01', 'FICTICIO Proyecto', $1) RETURNING id`, [resp]);
    await pool.query(`INSERT INTO stock_allocation (stock_balance_id, project_id, availability, quantity) VALUES ($1, $2, 'RESTRICTED', 6)`, [bal.id, p.rows[0].id]);
    ok(await call('POST', '/api/stock/withdraw', usuario, { balanceId: bal.id, quantity: 4 }));
    const res = await call('POST', '/api/stock/withdraw', usuario, { balanceId: bal.id, quantity: 1 });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('MATERIAL_RESTRINGIDO');
  });
});

describe('préstamos de herramientas', () => {
  let taladro: { id: string };

  it('solo se presta lo marcado como prestable; por defecto, 14 días', async () => {
    const llave = await newMaterial({ description: 'FICTICIO Llave fija 13' });
    ok(await call('POST', '/api/stock/receipt', almacen, { materialId: llave.id, containerId: caja2, quantity: 2 }), 201);
    expect((await call('POST', '/api/loans', usuario, { balanceId: (await balanceOf(llave.id, caja2))!.id })).json().error.code).toBe('NO_PRESTABLE');

    taladro = await newMaterial({ description: 'FICTICIO Taladro de batería', isLoanable: true });
    ok(await call('POST', '/api/stock/receipt', almacen, { materialId: taladro.id, containerId: caja2, quantity: 2 }), 201);
    ok(await call('POST', '/api/loans', usuario, { balanceId: (await balanceOf(taladro.id, caja2))!.id }), 201);
    const loans = ok<{ loans: Array<{ materialId: string; dueAt: string; borrowerName: string; fromCode: string }> }>(await call('GET', '/api/loans', usuario));
    const loan = loans.loans.find((l) => l.materialId === taladro.id)!;
    const days = (new Date(loan.dueAt).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13);
    expect(days).toBeLessThan(15);
    expect(loan.borrowerName).toBe('FICTICIO Usuario Estándar');
    expect((await balanceOf(taladro.id, caja2))!.q).toBe(1);
  });

  it('un usuario no presta a otro; un responsable sí', async () => {
    const otro = (await pool.query(`SELECT id FROM app_user WHERE username = 'demo.proyecto'`)).rows[0].id;
    const bal = (await balanceOf(taladro.id, caja2))!;
    expect((await call('POST', '/api/loans', usuario, { balanceId: bal.id, borrowerId: otro })).statusCode).toBe(403);
    ok(await call('POST', '/api/loans', almacen, { balanceId: bal.id, borrowerId: otro, dueDate: '2099-01-31' }), 201);
    expect(await balanceOf(taladro.id, caja2)).toBeUndefined();
  });

  it('al devolver vuelve a su sitio y el préstamo se cierra', async () => {
    const loans = ok<{ loans: Array<{ id: string; materialId: string; borrowerName: string }> }>(await call('GET', '/api/loans', usuario));
    const mine = loans.loans.find((l) => l.materialId === taladro.id && l.borrowerName === 'FICTICIO Usuario Estándar')!;
    const other = loans.loans.find((l) => l.materialId === taladro.id && l.borrowerName !== 'FICTICIO Usuario Estándar')!;
    expect((await call('POST', `/api/loans/${other.id}/return`, usuario, {})).statusCode).toBe(403);
    ok(await call('POST', `/api/loans/${mine.id}/return`, usuario, {}));
    expect((await balanceOf(taladro.id, caja2))!.q).toBe(1);
    expect((await call('POST', `/api/loans/${mine.id}/return`, usuario, {})).json().error.code).toBe('PRESTAMO_CERRADO');
  });
});

describe('exportar a Excel', () => {
  it('materiales y stock', async () => {
    for (const [path, sheet] of [['materiales', 'Materiales'], ['stock', 'Stock']]) {
      const res = await call('GET', `/api/export/${path}.xlsx`, consulta);
      expect(res.statusCode).toBe(200);
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(res.rawPayload as never);
      const ws = wb.getWorksheet(sheet)!;
      expect(ws.rowCount).toBeGreaterThan(3);
      expect(String(ws.getRow(1).getCell(1).value)).toBe('Referencia');
    }
  });
});
