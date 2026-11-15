/**
 * Pruebas de integridad del modelo de datos.
 *
 * Comprueban, contra un PostgreSQL real, que la base de datos rechaza por sí
 * sola los datos incoherentes. Todos los datos son ficticios y se crean y
 * descartan dentro de cada prueba (transacción con ROLLBACK).
 *
 * Requiere la variable TEST_DATABASE_URL apuntando a una base de datos vacía
 * que se pueda borrar.
 */
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../src/db/migrate.js';

const url = process.env.TEST_DATABASE_URL;
if (!url) throw new Error('Falta TEST_DATABASE_URL');

let pool: pg.Pool;

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await admin.end();
  await runMigrations(url);
  pool = new pg.Pool({ connectionString: url, max: 5 });
});

afterAll(async () => {
  await pool.end();
});

/** Ejecuta fn dentro de una transacción que siempre se deshace. */
async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    return await fn(c);
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

/** Espera que la consulta falle con el SQLSTATE indicado, sin romper la transacción. */
async function expectSqlError(c: pg.PoolClient, code: string, sql: string, params: unknown[] = []) {
  await c.query('SAVEPOINT sp');
  let got: string | undefined;
  try {
    await c.query(sql, params);
  } catch (e) {
    got = (e as { code?: string }).code;
  }
  await c.query('ROLLBACK TO SAVEPOINT sp');
  expect(got, `se esperaba el error ${code} en: ${sql}`).toBe(code);
}

const one = async <T = string>(c: pg.PoolClient, sql: string, params: unknown[] = []): Promise<T> => {
  const r = await c.query(sql, params);
  return Object.values(r.rows[0] as object)[0] as T;
};

// ---------------------------------------------------------------------------
// Datos ficticios mínimos
// ---------------------------------------------------------------------------
interface Fx {
  ana: string; // solicitante
  luis: string; // responsable del proyecto
  marta: string; // administradora técnica, sin capacidad de autorizar
  project: string;
  shelf: string; // ubicación
  pallet: string; // contenedor en la ubicación
  material: string; // EXACT, sin lote
  certMaterial: string; // EXACT, con lote obligatorio
  lot: string;
}

async function fixtures(c: pg.PoolClient): Promise<Fx> {
  const user = (name: string) =>
    one(c, `INSERT INTO app_user (username, full_name, password_hash) VALUES ($1, $2, 'x') RETURNING id`, [
      `ficticio.${name}.${randomUUID().slice(0, 8)}`,
      `FICTICIO ${name}`,
    ]);
  const ana = await user('ana');
  const luis = await user('luis');
  const marta = await user('marta');
  await c.query(
    `INSERT INTO user_role (user_id, role_id) SELECT $1, id FROM role WHERE code = 'ADMIN_TECNICO'`,
    [marta],
  );

  const project = await one(
    c,
    `INSERT INTO project (code, name, responsible_user_id) VALUES ($1, 'FICTICIO proyecto', $2) RETURNING id`,
    [`FIC-${randomUUID().slice(0, 8)}`, luis],
  );
  const shelf = await one(
    c,
    `INSERT INTO storage_location (qr_token, code, name, location_type_id)
     SELECT $1, $2, 'FICTICIO estante', id FROM location_type WHERE code = 'POSICION' RETURNING id`,
    [randomUUID(), `FIC-LOC-${randomUUID().slice(0, 8)}`],
  );
  const pallet = await newContainer(c, 'PALET', { location: shelf });
  const material = await one(
    c,
    `INSERT INTO material (internal_ref, description, family_id, unit_code)
     SELECT $1, 'FICTICIO tornillo', id, 'ud' FROM material_family WHERE code = 'TORNILLERIA' RETURNING id`,
    [`FIC-MAT-${randomUUID().slice(0, 8)}`],
  );
  const certMaterial = await one(
    c,
    `INSERT INTO material (internal_ref, description, family_id, unit_code, lot_tracked)
     SELECT $1, 'FICTICIO barra con certificado', id, 'ud', true FROM material_family WHERE code = 'BARRA' RETURNING id`,
    [`FIC-MAT-${randomUUID().slice(0, 8)}`],
  );
  const lot = await one(
    c,
    `INSERT INTO material_lot (material_id, lot_code, heat_number) VALUES ($1, 'FIC-LOTE-1', 'FIC-COLADA-1') RETURNING id`,
    [certMaterial],
  );
  return { ana, luis, marta, project, shelf, pallet, material, certMaterial, lot };
}

async function newContainer(
  c: pg.PoolClient,
  type: string,
  where: { location?: string; parent?: string },
): Promise<string> {
  return one(
    c,
    `INSERT INTO container (qr_token, code, container_type_id, location_id, parent_container_id)
     SELECT $1, $2, id, $3, $4 FROM container_type WHERE code = $5 RETURNING id`,
    [randomUUID(), `FIC-${type}-${randomUUID().slice(0, 8)}`, where.location ?? null, where.parent ?? null, type],
  );
}

const newBalance = (c: pg.PoolClient, material: string, container: string, qty: number | null, lot: string | null = null) =>
  one(
    c,
    `INSERT INTO stock_balance (material_id, lot_id, container_id, quantity) VALUES ($1, $2, $3, $4) RETURNING id`,
    [material, lot, container, qty],
  );

/** Saldo de 100, asignación restringida de 40 y solicitud de 30 hecha por Ana. */
async function requestFixture(c: pg.PoolClient, f: Fx) {
  const balance = await newBalance(c, f.material, f.pallet, 100);
  const allocation = await one(
    c,
    `INSERT INTO stock_allocation (stock_balance_id, project_id, availability, quantity)
     VALUES ($1, $2, 'RESTRICTED', 40) RETURNING id`,
    [balance, f.project],
  );
  const request = await one(
    c,
    `INSERT INTO withdrawal_request
       (requester_id, stock_allocation_id, material_id, container_id, project_id, quantity_requested, reason)
     VALUES ($1, $2, $3, $4, $5, 30, 'FICTICIO montaje') RETURNING id`,
    [f.ana, allocation, f.material, f.pallet, f.project],
  );
  return { balance, allocation, request };
}

// ---------------------------------------------------------------------------

describe('migraciones', () => {
  it('se pueden ejecutar dos veces sin cambios', async () => {
    const files = (await import('node:fs')).readdirSync(new URL('../migrations/', import.meta.url)).filter((f) => f.endsWith('.sql'));
    const again = await runMigrations(url);
    expect(again.applied).toEqual([]);
    expect(again.skipped).toHaveLength(files.length);
  });

  it('crean las 38 tablas del modelo y las 6 vistas', async () => {
    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> 'schema_migrations'`,
    );
    expect(tables.rowCount).toBe(38);
    const names = tables.rows.map((r) => r.table_name);
    for (const t of [
      'material', 'material_lot', 'storage_location', 'container', 'stock_balance', 'stock_allocation',
      'stock_reservation', 'stock_movement', 'stock_movement_line', 'project', 'project_authorizer',
      'customer', 'business_line', 'app_user', 'user_session', 'role', 'permission', 'withdrawal_request',
      'withdrawal_authorization', 'document', 'document_version', 'document_relation', 'equipment',
      'calibration_record', 'tool_loan', 'idempotency_key', 'system_parameter', 'audit_log',
    ]) {
      expect(names).toContain(t);
    }
    const views = await pool.query(`SELECT table_name FROM information_schema.views WHERE table_schema = 'public'`);
    expect(views.rows.map((r) => r.table_name).sort()).toEqual([
      'container_content', 'container_effective_location', 'container_lot_document',
      'equipment_calibration_status', 'material_stock', 'stock_availability',
    ]);
  });
});

describe('datos de sistema', () => {
  it('existen los cinco roles iniciales', async () => {
    const r = await pool.query(`SELECT code FROM role ORDER BY code`);
    expect(r.rows.map((x) => x.code)).toEqual(['ADMIN_TECNICO', 'CONSULTA', 'RESP_ALMACEN', 'RESP_PROYECTO', 'USUARIO']);
  });

  it('el usuario de consulta solo tiene permisos de lectura', async () => {
    const r = await pool.query(
      `SELECT p.code FROM role_permission rp JOIN role r ON r.id = rp.role_id JOIN permission p ON p.id = rp.permission_id
        WHERE r.code = 'CONSULTA'`,
    );
    expect(r.rows.every((x) => x.code.endsWith('.read'))).toBe(true);
  });

  it('el administrador técnico no opera inventario por tener ese rol', async () => {
    const r = await pool.query(
      `SELECT p.code FROM role_permission rp JOIN role r ON r.id = rp.role_id JOIN permission p ON p.id = rp.permission_id
        WHERE r.code = 'ADMIN_TECNICO' AND p.code LIKE 'stock.%' AND p.code <> 'stock.read'`,
    );
    expect(r.rowCount).toBe(0);
  });

  it('los parámetros por defecto son 24 h de reserva y 14 días de préstamo', async () => {
    const r = await pool.query(
      `SELECT key, value FROM system_parameter WHERE key IN ('reservation.expiry_hours', 'loan.default_days') ORDER BY key`,
    );
    expect(r.rows).toEqual([
      { key: 'loan.default_days', value: 14 },
      { key: 'reservation.expiry_hours', value: 24 },
    ]);
  });
});

describe('ubicaciones y contenedores', () => {
  it('un contenedor activo está en una ubicación o dentro de otro, nunca ambas ni ninguna', () =>
    tx(async (c) => {
      const f = await fixtures(c);
      await expectSqlError(
        c, '23514',
        `INSERT INTO container (qr_token, code, container_type_id, location_id, parent_container_id)
         SELECT 'fic-a', 'FIC-X1', id, $1, $2 FROM container_type WHERE code = 'CAJA'`,
        [f.shelf, f.pallet],
      );
      await expectSqlError(
        c, '23514',
        `INSERT INTO container (qr_token, code, container_type_id)
         SELECT 'fic-b', 'FIC-X2', id FROM container_type WHERE code = 'CAJA'`,
      );
    }));

  it('rechaza ciclos de contenedores', () =>
    tx(async (c) => {
      const f = await fixtures(c);
      const box = await newContainer(c, 'CAJA', { parent: f.pallet });
      const inner = await newContainer(c, 'CAJA', { parent: box });
      await expectSqlError(
        c, 'SG002',
        `UPDATE container SET parent_container_id = $1, location_id = NULL WHERE id = $2`,
        [inner, f.pallet],
      );
    }));

  it('rechaza ciclos de ubicaciones', () =>
    tx(async (c) => {
      const f = await fixtures(c);
      const child = await one(
        c,
        `INSERT INTO storage_location (qr_token, code, name, location_type_id, parent_id)
         SELECT 'fic-c', 'FIC-HIJA', 'FICTICIO', id, $1 FROM location_type WHERE code = 'CAJON' RETURNING id`,
        [f.shelf],
      );
      await expectSqlError(c, 'SG001', `UPDATE storage_location SET parent_id = $1 WHERE id = $2`, [child, f.shelf]);
    }));

  it('mover un palet cambia la ubicación efectiva de todos sus descendientes con una sola escritura', () =>
    tx(async (c) => {
      const f = await fixtures(c);
      const box = await newContainer(c, 'CAJA', { parent: f.pallet });
      const inner = await newContainer(c, 'BANDEJA', { parent: box });
      const other = await one(
        c,
        `INSERT INTO storage_location (qr_token, code, name, location_type_id)
         SELECT 'fic-d', 'FIC-OTRA', 'FICTICIO', id FROM location_type WHERE code = 'POSICION' RETURNING id`,
      );
      const where = (id: string) =>
        one(c, `SELECT location_id FROM container_effective_location WHERE container_id = $1`, [id]);

      expect(await where(inner)).toBe(f.shelf);
      const moved = await c.query(`UPDATE container SET location_id = $1 WHERE id = $2`, [other, f.pallet]);
      expect(moved.rowCount).toBe(1);
      expect(await where(f.pallet)).toBe(other);
      expect(await where(box)).toBe(other);
      expect(await where(inner)).toBe(other);
    }));

  it('el token QR no se puede cambiar; el código legible sí', () =>
    tx(async (c) => {
      const f = await fixtures(c);
      await expectSqlError(c, 'SG014', `UPDATE container SET qr_token = 'otro' WHERE id = $1`, [f.pallet]);
      await expectSqlError(c, 'SG014', `UPDATE storage_location SET qr_token = 'otro' WHERE id = $1`, [f.shelf]);
      const r = await c.query(`UPDATE container SET code = 'FIC-RENOMBRADO' WHERE id = $1`, [f.pallet]);
      expect(r.rowCount).toBe(1);
    }));
});

describe('stock físico', () => {
  it('rechaza cantidades negativas', () =>
    tx(async (c) => {
      const f = await fixtures(c);
      const b = await newBalance(c, f.material, f.pallet, 100);
      await expectSqlError(c, '23514', `UPDATE stock_balance SET quantity = quantity - 101 WHERE id = $1`, [b]);
      await c.query(`UPDATE stock_balance SET quantity = quantity - 100 WHERE id = $1`, [b]);
      expect(Number(await one(c, `SELECT quantity FROM stock_balance WHERE id = $1`, [b]))).toBe(0);
    }));

  it('exige lote en los materiales con control de lote', () =>
    tx(async (c) => {
      const f = await fixtures(c);
      await expectSqlError(
        c, 'SG003',
        `INSERT INTO stock_balance (material_id, container_id, quantity) VALUES ($1, $2, 10)`,
        [f.certMaterial, f.pallet],
      );
      await newBalance(c, f.certMaterial, f.pallet, 10, f.lot);
    }));

  it('no admite un lote de otro material', () =>
    tx(async (c) => {
      const f = await fixtures(c);
      await expectSqlError(
        c, '23503',
        `INSERT INTO stock_balance (material_id, lot_id, container_id, quantity) VALUES ($1, $2, $3, 10)`,
        [f.material, f.lot, f.pallet],
      );
    }));

  it('el stock vive en un contenedor o en una ubicación, no en ambos', () =>
    tx(async (c) => {
      const f = await fixtures(c);
      await expectSqlError(
        c, '23514',
        `INSERT INTO stock_balance (material_id, container_id, location_id, quantity) VALUES ($1, $2, $3, 10)`,
        [f.material, f.pallet, f.shelf],
      );
      await c.query(`INSERT INTO stock_balance (material_id, location_id, quantity) VALUES ($1, $2, 10)`, [
        f.material, f.shelf,
      ]);
    }));

  it('no duplica el saldo de un mismo material y lote en un mismo lugar', () =>
    tx(async (c) => {
      const f = await fixtures(c);
      await newBalance(c, f.material, f.pallet, 10);
      await expectSqlError(
        c, '23505',
        `INSERT INTO stock_balance (material_id, container_id, quantity) VALUES ($1, $2, 5)`,
        [f.material, f.pallet],
      );
    }));

  it('los materiales sin control de cantidad no llevan cantidad, y el resto la exige', () =>
    tx(async (c) => {
      const f = await fixtures(c);
      const loose = await one(
        c,
        `INSERT INTO material (internal_ref, description, family_id, unit_code, quantity_tracking)
         SELECT 'FIC-SIN-CONTROL', 'FICTICIO trapos', id, 'ud', 'NOT_TRACKED' FROM material_family WHERE code = 'CONSUMIBLE'
         RETURNING id`,
      );
      await expectSqlError(
        c, 'SG004',
        `INSERT INTO stock_balance (material_id, container_id, quantity) VALUES ($1, $2, 5)`,
        [loose, f.pallet],
      );
      await newBalance(c, loose, f.pallet, null);
      await expectSqlError(
        c, 'SG004',
        `INSERT INTO stock_balance (material_id, location_id, quantity) VALUES ($1, $2, NULL)`,
        [f.material, f.shelf],
      );
    }));

  it('dos retiradas simultáneas no dejan el stock en negativo', async () => {
    const setup = await pool.connect();
    const a = await pool.connect();
    const b = await pool.connect();
    let balance = '';
    try {
      // Esta prueba necesita datos confirmados para que las dos conexiones los vean.
      await setup.query('BEGIN');
      const f = await fixtures(setup);
      balance = await newBalance(setup, f.material, f.pallet, 100);
      await setup.query('COMMIT');

      await a.query('BEGIN');
      await b.query('BEGIN');
      await a.query(`UPDATE stock_balance SET quantity = quantity - 60 WHERE id = $1`, [balance]);
      // b queda en espera hasta que a confirme
      const second = b.query(`UPDATE stock_balance SET quantity = quantity - 60 WHERE id = $1`, [balance]);
      await a.query('COMMIT');
      await expect(second).rejects.toMatchObject({ code: '23514' });
      await b.query('ROLLBACK');

      expect(Number(await one(setup, `SELECT quantity FROM stock_balance WHERE id = $1`, [balance]))).toBe(40);
    } finally {
      // Limpieza de los datos ficticios confirmados.
      await setup.query(`DELETE FROM stock_balance WHERE id = $1`, [balance]);
      await setup.query(`DELETE FROM container WHERE code LIKE 'FIC-%'`);
      await setup.query(`DELETE FROM storage_location WHERE code LIKE 'FIC-%'`);
      await setup.query(`DELETE FROM material_lot WHERE lot_code LIKE 'FIC-%'`);
      await setup.query(`DELETE FROM material WHERE internal_ref LIKE 'FIC-%'`);
      await setup.query(`DELETE FROM project WHERE code LIKE 'FIC-%'`);
      await setup.query(`DELETE FROM app_user WHERE username LIKE 'ficticio.%'`);
      setup.release();
      a.release();
      b.release();
    }
  });
});

describe('asignaciones y reservas', () => {
  it('las asignaciones no pueden superar el stock físico', () =>
    tx(async (c) => {
      const f = await fixtures(c);
      const b = await newBalance(c, f.material, f.pallet, 100);
      await c.query(
        `INSERT INTO stock_allocation (stock_balance_id, project_id, availability, quantity) VALUES ($1, $2, 'RESTRICTED', 70)`,
        [b, f.project],
      );
      await expectSqlError(
        c, 'SG006',
        `INSERT INTO stock_allocation (stock_balance_id, project_id, availability, quantity) VALUES ($1, $2, 'FREE', 31)`,
        [b, f.project],
      );
      await expectSqlError(c, 'SG006', `UPDATE stock_allocation SET quantity = 101 WHERE stock_balance_id = $1`, [b]);
    }));

  it('no se puede bajar el físico por debajo de lo asignado', () =>
    tx(async (c) => {
      const f = await fixtures(c);
      const b = await newBalance(c, f.material, f.pallet, 100);
      await c.query(
        `INSERT INTO stock_allocation (stock_balance_id, project_id, availability, quantity) VALUES ($1, $2, 'RESTRICTED', 70)`,
        [b, f.project],
      );
      await expectSqlError(c, 'SG006', `UPDATE stock_balance SET quantity = 69 WHERE id = $1`, [b]);
      await c.query(`UPDATE stock_balance SET quantity = 70 WHERE id = $1`, [b]);
    }));

  it('la vista de disponibilidad separa físico, restringido y libre', () =>
    tx(async (c) => {
      const f = await fixtures(c);
      const b = await newBalance(c, f.material, f.pallet, 100);
      await c.query(
        `INSERT INTO stock_allocation (stock_balance_id, project_id, availability, quantity) VALUES ($1, $2, 'RESTRICTED', 40)`,
        [b, f.project],
      );
      const r = await c.query(
        `SELECT quantity, quantity_restricted, quantity_free FROM stock_availability WHERE stock_balance_id = $1`,
        [b],
      );
      expect(r.rows[0]).toMatchObject({ quantity: '100.0000', quantity_restricted: '40.0000', quantity_free: '60.0000' });
    }));

  it('las reservas activas no pueden superar la asignación; aprobar no descuenta stock', () =>
    tx(async (c) => {
      const f = await fixtures(c);
      const { balance, allocation, request } = await requestFixture(c, f);
      const auth = await one(
        c,
        `INSERT INTO withdrawal_authorization (request_id, authorizer_id, decision, quantity_authorized)
         VALUES ($1, $2, 'APPROVED', 30) RETURNING id`,
        [request, f.luis],
      );
      await c.query(
        `INSERT INTO stock_reservation (request_id, authorization_id, stock_allocation_id, quantity, expires_at)
         VALUES ($1, $2, $3, 30, now() + interval '24 hours')`,
        [request, auth, allocation],
      );
      // El físico sigue intacto tras aprobar y reservar.
      expect(Number(await one(c, `SELECT quantity FROM stock_balance WHERE id = $1`, [balance]))).toBe(100);
      expect(Number(await one(c, `SELECT quantity_reserved FROM stock_availability WHERE stock_balance_id = $1`, [balance]))).toBe(30);

      // No se puede reducir la asignación por debajo de lo reservado.
      await expectSqlError(c, 'SG007', `UPDATE stock_allocation SET quantity = 29 WHERE id = $1`, [allocation]);
      // Una reserva caducada libera la cantidad.
      await c.query(`UPDATE stock_reservation SET status = 'EXPIRED', closed_at = now() WHERE request_id = $1`, [request]);
      await c.query(`UPDATE stock_allocation SET quantity = 29 WHERE id = $1`, [allocation]);
    }));
});

describe('autorizaciones', () => {
  it('la solicitud debe coincidir con el material, lugar y proyecto de la asignación', () =>
    tx(async (c) => {
      const f = await fixtures(c);
      const { allocation } = await requestFixture(c, f);
      const otherPallet = await newContainer(c, 'PALET', { location: f.shelf });
      await expectSqlError(
        c, 'SG012',
        `INSERT INTO withdrawal_request
           (requester_id, stock_allocation_id, material_id, container_id, project_id, quantity_requested, reason)
         VALUES ($1, $2, $3, $4, $5, 5, 'FICTICIO')`,
        [f.ana, allocation, f.material, otherPallet, f.project],
      );
    }));

  it('nadie aprueba su propia solicitud, salvo política explícita del proyecto', () =>
    tx(async (c) => {
      const f = await fixtures(c);
      const { request } = await requestFixture(c, f);
      await c.query(`INSERT INTO project_authorizer (project_id, user_id, kind) VALUES ($1, $2, 'DEPUTY')`, [
        f.project, f.ana,
      ]);
      const sql = `INSERT INTO withdrawal_authorization (request_id, authorizer_id, decision, quantity_authorized)
                   VALUES ($1, $2, 'APPROVED', 30)`;
      await expectSqlError(c, 'SG008', sql, [request, f.ana]);
      await c.query(`UPDATE project SET allow_self_approval = true WHERE id = $1`, [f.project]);
      await c.query(sql, [request, f.ana]);
    }));

  it('ser administrador técnico no permite autorizar', () =>
    tx(async (c) => {
      const f = await fixtures(c);
      const { request } = await requestFixture(c, f);
      await expectSqlError(
        c, 'SG009',
        `INSERT INTO withdrawal_authorization (request_id, authorizer_id, decision, quantity_authorized)
         VALUES ($1, $2, 'APPROVED', 30)`,
        [request, f.marta],
      );
    }));

  it('una aprobación parcial autoriza menos de lo pedido, y solo hay una decisión por solicitud', () =>
    tx(async (c) => {
      const f = await fixtures(c);
      const { request } = await requestFixture(c, f);
      const sql = `INSERT INTO withdrawal_authorization (request_id, authorizer_id, decision, quantity_authorized)
                   VALUES ($1, $2, $3, $4)`;
      await expectSqlError(c, 'SG010', sql, [request, f.luis, 'PARTIALLY_APPROVED', 30]);
      await expectSqlError(c, 'SG010', sql, [request, f.luis, 'APPROVED', 20]);
      await expectSqlError(c, '23514', sql, [request, f.luis, 'REJECTED', 5]);
      await c.query(sql, [request, f.luis, 'PARTIALLY_APPROVED', 20]);
      await expectSqlError(c, '23505', sql, [request, f.luis, 'REJECTED', null]);
    }));
});

describe('material restringido sin proyecto', () => {
  /** Saldo de 100 con 40 restringidas sin proyecto, bajo la responsabilidad de Luis. */
  async function noProject(c: pg.PoolClient, f: Fx) {
    const balance = await newBalance(c, f.material, f.pallet, 100);
    const allocation = await one(
      c,
      `INSERT INTO stock_allocation (stock_balance_id, availability, quantity, responsible_user_id)
       VALUES ($1, 'RESTRICTED', 40, $2) RETURNING id`,
      [balance, f.luis],
    );
    const request = (who: string) =>
      one(
        c,
        `INSERT INTO withdrawal_request
           (requester_id, stock_allocation_id, material_id, container_id, quantity_requested, reason)
         VALUES ($1, $2, $3, $4, 10, 'FICTICIO uso puntual') RETURNING id`,
        [who, allocation, f.material, f.pallet],
      );
    return { balance, allocation, request };
  }
  const approve = `INSERT INTO withdrawal_authorization (request_id, authorizer_id, decision, quantity_authorized)
                   VALUES ($1, $2, 'APPROVED', 10)`;

  it('solo admite la modalidad restringida; la persona designada es opcional', () =>
    tx(async (c) => {
      const f = await fixtures(c);
      const b = await newBalance(c, f.material, f.pallet, 100);
      await expectSqlError(
        c, '23514',
        `INSERT INTO stock_allocation (stock_balance_id, availability, quantity, responsible_user_id)
         VALUES ($1, 'FREE', 10, $2)`,
        [b, f.luis],
      );
      const r = await c.query(
        `INSERT INTO stock_allocation (stock_balance_id, availability, quantity) VALUES ($1, 'RESTRICTED', 10)`,
        [b],
      );
      expect(r.rowCount).toBe(1);
    }));

  it('cuenta como restringido y convive con el reparto por proyecto sin superar el físico', () =>
    tx(async (c) => {
      const f = await fixtures(c);
      const { balance } = await noProject(c, f);
      await c.query(
        `INSERT INTO stock_allocation (stock_balance_id, project_id, availability, quantity) VALUES ($1, $2, 'RESTRICTED', 50)`,
        [balance, f.project],
      );
      const r = await c.query(
        `SELECT quantity_restricted, quantity_free FROM stock_availability WHERE stock_balance_id = $1`,
        [balance],
      );
      expect(r.rows[0]).toMatchObject({ quantity_restricted: '90.0000', quantity_free: '10.0000' });
      await expectSqlError(
        c, 'SG006',
        `UPDATE stock_allocation SET quantity = 61 WHERE stock_balance_id = $1 AND project_id IS NOT NULL`,
        [balance],
      );
      // No puede haber dos asignaciones restringidas sin proyecto sobre el mismo saldo.
      await expectSqlError(
        c, '23505',
        `INSERT INTO stock_allocation (stock_balance_id, availability, quantity, responsible_user_id)
         VALUES ($1, 'RESTRICTED', 5, $2)`,
        [balance, f.ana],
      );
    }));

  it('autorizan la persona designada, los responsables de almacén y los administradores; nunca la propia solicitud', () =>
    tx(async (c) => {
      const f = await fixtures(c);
      const { request } = await noProject(c, f); // Luis es la persona designada
      const warehouse = await one(
        c,
        `INSERT INTO app_user (username, full_name, password_hash) VALUES ('ficticio.almacenero', 'FICTICIO almacén', 'x') RETURNING id`,
      );
      await c.query(`INSERT INTO user_role (user_id, role_id) SELECT $1, id FROM role WHERE code = 'RESP_ALMACEN'`, [warehouse]);
      const standard = await one(
        c,
        `INSERT INTO app_user (username, full_name, password_hash) VALUES ('ficticio.estandar', 'FICTICIO estándar', 'x') RETURNING id`,
      );
      await c.query(`INSERT INTO user_role (user_id, role_id) SELECT $1, id FROM role WHERE code = 'USUARIO'`, [standard]);

      // Un usuario estándar no puede autorizar.
      await expectSqlError(c, 'SG009', approve, [await request(f.ana), standard]);
      // La persona designada, el responsable de almacén y la administradora, sí.
      await c.query(approve, [await request(f.ana), f.luis]);
      await c.query(approve, [await request(f.ana), warehouse]);
      await c.query(approve, [await request(f.ana), f.marta]);
      // Nadie aprueba lo que ha pedido él mismo.
      await expectSqlError(c, 'SG008', approve, [await request(f.luis), f.luis]);
      await expectSqlError(c, 'SG008', approve, [await request(f.marta), f.marta]);
      await expectSqlError(c, 'SG008', approve, [await request(warehouse), warehouse]);
      // Un responsable de almacén desactivado deja de poder autorizar.
      await c.query(`UPDATE app_user SET active = false WHERE id = $1`, [warehouse]);
      await expectSqlError(c, 'SG009', approve, [await request(f.ana), warehouse]);
    }));

  it('la solicitud sin proyecto no puede apuntar a una asignación de proyecto', () =>
    tx(async (c) => {
      const f = await fixtures(c);
      const { allocation } = await requestFixture(c, f);
      await expectSqlError(
        c, 'SG012',
        `INSERT INTO withdrawal_request
           (requester_id, stock_allocation_id, material_id, container_id, quantity_requested, reason)
         VALUES ($1, $2, $3, $4, 5, 'FICTICIO')`,
        [f.ana, allocation, f.material, f.pallet],
      );
    }));
});

describe('movimientos y auditoría', () => {
  const newMovement = (c: pg.PoolClient, user: string, type = 'RECEIPT', extra: Record<string, unknown> = {}) =>
    one(
      c,
      `INSERT INTO stock_movement (movement_type, performed_by, reverses_movement_id, idempotency_key)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [type, user, extra.reverses ?? null, extra.key ?? null],
    );

  it('los movimientos y sus líneas no se pueden modificar ni borrar', () =>
    tx(async (c) => {
      const f = await fixtures(c);
      const m = await newMovement(c, f.ana);
      await c.query(
        `INSERT INTO stock_movement_line (movement_id, line_no, material_id, container_id, quantity_delta, quantity_after)
         VALUES ($1, 1, $2, $3, 100, 100)`,
        [m, f.material, f.pallet],
      );
      await expectSqlError(c, 'SG011', `UPDATE stock_movement SET reason = 'cambio' WHERE id = $1`, [m]);
      await expectSqlError(c, 'SG011', `DELETE FROM stock_movement_line WHERE movement_id = $1`, [m]);
      await expectSqlError(c, 'SG011', `UPDATE stock_movement_line SET quantity_delta = 1 WHERE movement_id = $1`, [m]);
      await expectSqlError(c, 'SG011', `TRUNCATE stock_movement CASCADE`);
    }));

  it('un movimiento solo se puede revertir una vez', () =>
    tx(async (c) => {
      const f = await fixtures(c);
      const m = await newMovement(c, f.ana);
      await newMovement(c, f.ana, 'REVERSAL', { reverses: m });
      await expectSqlError(
        c, '23505',
        `INSERT INTO stock_movement (movement_type, performed_by, reverses_movement_id) VALUES ('REVERSAL', $1, $2)`,
        [f.ana, m],
      );
      // Un reverso debe apuntar a un movimiento, y solo un reverso puede hacerlo.
      await expectSqlError(c, '23514', `INSERT INTO stock_movement (movement_type, performed_by) VALUES ('REVERSAL', $1)`, [f.ana]);
    }));

  it('la clave de idempotencia impide registrar dos veces el mismo movimiento', () =>
    tx(async (c) => {
      const f = await fixtures(c);
      await newMovement(c, f.ana, 'RECEIPT', { key: 'fic-clave-1' });
      await expectSqlError(
        c, '23505',
        `INSERT INTO stock_movement (movement_type, performed_by, idempotency_key) VALUES ('RECEIPT', $1, 'fic-clave-1')`,
        [f.ana],
      );
    }));

  it('el registro de auditoría solo admite altas', () =>
    tx(async (c) => {
      const f = await fixtures(c);
      await c.query(`INSERT INTO audit_log (user_id, action) VALUES ($1, 'ficticio.prueba')`, [f.ana]);
      await expectSqlError(c, 'SG011', `UPDATE audit_log SET action = 'x'`);
      await expectSqlError(c, 'SG011', `DELETE FROM audit_log`);
    }));
});

describe('documentación y equipos', () => {
  it('el certificado de un lote se ve desde cualquier caja que contenga ese lote', () =>
    tx(async (c) => {
      const f = await fixtures(c);
      await newBalance(c, f.certMaterial, f.pallet, 100, f.lot);
      const doc = await one(
        c,
        `INSERT INTO document (document_type_id, title, certificate_number, created_by)
         SELECT id, 'FICTICIO certificado 3.1', 'FIC-CERT-1', $1 FROM document_type WHERE code = 'CERT_EN10204_31' RETURNING id`,
        [f.ana],
      );
      await c.query(`INSERT INTO document_relation (document_id, lot_id, created_by) VALUES ($1, $2, $3)`, [
        doc, f.lot, f.ana,
      ]);

      // División del palet: 40 unidades pasan a una caja nueva.
      const box = await newContainer(c, 'CAJA', { parent: f.pallet });
      await c.query(`UPDATE stock_balance SET quantity = quantity - 40 WHERE container_id = $1 AND lot_id = $2`, [
        f.pallet, f.lot,
      ]);
      await newBalance(c, f.certMaterial, box, 40, f.lot);

      const docs = (id: string) =>
        c.query(`SELECT document_id FROM container_lot_document WHERE container_id = $1`, [id]);
      expect((await docs(f.pallet)).rows).toEqual([{ document_id: doc }]);
      expect((await docs(box)).rows).toEqual([{ document_id: doc }]);
    }));

  it('una relación documental apunta exactamente a una cosa', () =>
    tx(async (c) => {
      const f = await fixtures(c);
      const doc = await one(
        c,
        `INSERT INTO document (document_type_id, title, created_by)
         SELECT id, 'FICTICIO', $1 FROM document_type WHERE code = 'PLANO' RETURNING id`,
        [f.ana],
      );
      await expectSqlError(
        c, '23514',
        `INSERT INTO document_relation (document_id, lot_id, project_id, created_by) VALUES ($1, $2, $3, $4)`,
        [doc, f.lot, f.project, f.ana],
      );
      await expectSqlError(c, '23514', `INSERT INTO document_relation (document_id, created_by) VALUES ($1, $2)`, [
        doc, f.ana,
      ]);
    }));

  it('la vista de calibración distingue vigente, próxima y vencida', () =>
    tx(async (c) => {
      const eq = (code: string, next: string) =>
        c.query(
          `INSERT INTO equipment (qr_token, code, description, next_calibration_on)
           VALUES ($1, $2, 'FICTICIO calibre', current_date + $3::int)`,
          [randomUUID(), code, next],
        );
      await eq('FIC-EQ-VENCIDO', '-1');
      await eq('FIC-EQ-PROXIMO', '10');
      await eq('FIC-EQ-VIGENTE', '200');
      const r = await c.query(
        `SELECT code, calibration_status FROM equipment_calibration_status WHERE code LIKE 'FIC-EQ-%' ORDER BY code`,
      );
      expect(r.rows).toEqual([
        { code: 'FIC-EQ-PROXIMO', calibration_status: 'DUE_SOON' },
        { code: 'FIC-EQ-VENCIDO', calibration_status: 'EXPIRED' },
        { code: 'FIC-EQ-VIGENTE', calibration_status: 'VALID' },
      ]);
    }));

  it('un equipo solo puede tener un préstamo abierto', () =>
    tx(async (c) => {
      const f = await fixtures(c);
      const eq = await one(
        c,
        `INSERT INTO equipment (qr_token, code, description) VALUES ($1, 'FIC-EQ-PRESTAMO', 'FICTICIO micrómetro') RETURNING id`,
        [randomUUID()],
      );
      const sql = `INSERT INTO tool_loan (equipment_id, borrower_id, due_at) VALUES ($1, $2, now() + interval '14 days')`;
      await c.query(sql, [eq, f.ana]);
      await expectSqlError(c, '23505', sql, [eq, f.luis]);
      await c.query(`UPDATE tool_loan SET status = 'RETURNED', returned_at = now() WHERE equipment_id = $1`, [eq]);
      await c.query(sql, [eq, f.luis]);
    }));
});
