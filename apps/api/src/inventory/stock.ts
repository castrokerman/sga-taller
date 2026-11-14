import type pg from 'pg';
import { badRequest, conflict, notFound } from '../errors.js';

/**
 * Núcleo del inventario. Toda variación de stock pasa por aquí:
 * se crea un movimiento con sus líneas y se actualiza el saldo físico,
 * todo dentro de la misma transacción y con el saldo bloqueado.
 */

export type Tracking = 'EXACT' | 'ESTIMATED' | 'NOT_TRACKED';
export type MovementType =
  | 'RECEIPT' | 'WITHDRAWAL' | 'RETURN' | 'TRANSFER' | 'COUNT' | 'ADJUSTMENT' | 'LOAN_OUT' | 'LOAN_RETURN' | 'REVERSAL';

export interface Place {
  containerId: string | null;
  locationId: string | null;
  /** Código para mostrar: CAJ-000014 o ALM-A-P01. */
  code: string;
}

export interface MaterialInfo {
  id: string;
  internalRef: string;
  description: string;
  unitCode: string;
  decimals: number;
  tracking: Tracking;
  lotTracked: boolean;
  isLoanable: boolean;
  status: string;
}

export async function getMaterial(c: pg.PoolClient, id: string): Promise<MaterialInfo> {
  const r = await c.query(
    `SELECT m.id, m.internal_ref AS "internalRef", m.description, m.unit_code AS "unitCode", u.decimals,
            m.quantity_tracking AS tracking, m.lot_tracked AS "lotTracked", m.is_loanable AS "isLoanable", m.status
       FROM material m JOIN unit_of_measure u ON u.code = m.unit_code WHERE m.id = $1`,
    [id],
  );
  if (!r.rows[0]) throw notFound('El material no existe');
  return r.rows[0];
}

/** Comprueba que el sitio existe y admite material: un contenedor activo o una ubicación activa. */
export async function resolvePlace(c: pg.PoolClient, p: { containerId?: string | null; locationId?: string | null }): Promise<Place> {
  if (Boolean(p.containerId) === Boolean(p.locationId)) {
    throw badRequest('Indica dónde: un contenedor o una ubicación', 'SITIO_NO_VALIDO');
  }
  if (p.containerId) {
    const r = await c.query(`SELECT code, status FROM container WHERE id = $1`, [p.containerId]);
    if (!r.rows[0]) throw badRequest('El contenedor no existe', 'CONTENEDOR_NO_EXISTE');
    if (r.rows[0].status !== 'ACTIVE') throw conflict('El contenedor está retirado', 'CONTENEDOR_RETIRADO');
    return { containerId: p.containerId, locationId: null, code: r.rows[0].code };
  }
  const r = await c.query(`SELECT code, active FROM storage_location WHERE id = $1`, [p.locationId]);
  if (!r.rows[0]) throw badRequest('La ubicación no existe', 'UBICACION_NO_EXISTE');
  if (!r.rows[0].active) throw conflict('La ubicación está desactivada', 'UBICACION_INACTIVA');
  return { containerId: null, locationId: p.locationId!, code: r.rows[0].code };
}

/** Comprueba que una cantidad encaja con la unidad del material. */
export function checkQuantity(m: MaterialInfo, quantity: number | null | undefined, what = 'La cantidad'): number | null {
  if (m.tracking === 'NOT_TRACKED') return null;
  if (quantity === null || quantity === undefined || !Number.isFinite(quantity) || quantity <= 0) {
    throw badRequest(`${what} debe ser mayor que cero`, 'CANTIDAD_NO_VALIDA');
  }
  const factor = 10 ** m.decimals;
  if (Math.abs(Math.round(quantity * factor) - quantity * factor) > 1e-6) {
    throw badRequest(
      m.decimals === 0 ? `${what} en ${m.unitCode} debe ser un número entero` : `${what} admite como mucho ${m.decimals} decimales`,
      'CANTIDAD_NO_VALIDA',
    );
  }
  return quantity;
}

/** Busca el lote por su código y, si no existe, lo crea. */
export async function findOrCreateLot(c: pg.PoolClient, materialId: string, lotCode: string | null | undefined): Promise<string | null> {
  const code = lotCode?.trim();
  if (!code) return null;
  const r = await c.query(
    `INSERT INTO material_lot (material_id, lot_code) VALUES ($1, $2)
     ON CONFLICT (material_id, lot_code) DO UPDATE SET lot_code = EXCLUDED.lot_code RETURNING id`,
    [materialId, code],
  );
  return r.rows[0].id;
}

export interface Balance {
  id: string;
  materialId: string;
  lotId: string | null;
  containerId: string | null;
  locationId: string | null;
  quantity: number | null;
  /** Lo que no está restringido a un proyecto. */
  free: number | null;
}

/** Lee y bloquea un saldo: dos retiradas a la vez sobre el mismo stock esperan su turno. */
export async function lockBalance(c: pg.PoolClient, id: string): Promise<Balance> {
  const r = await c.query(
    `SELECT b.id, b.material_id AS "materialId", b.lot_id AS "lotId", b.container_id AS "containerId",
            b.location_id AS "locationId", b.quantity::float AS quantity
       FROM stock_balance b WHERE b.id = $1 FOR UPDATE`,
    [id],
  );
  const b = r.rows[0];
  if (!b) throw notFound('Ese material ya no está en ese sitio. Actualiza la pantalla');
  const a = await c.query(
    `SELECT coalesce(sum(quantity) FILTER (WHERE availability = 'RESTRICTED'), 0)::float AS restricted
       FROM stock_allocation WHERE stock_balance_id = $1`,
    [id],
  );
  b.free = b.quantity === null ? null : b.quantity - a.rows[0].restricted;
  return b;
}

export async function createMovement(
  c: pg.PoolClient,
  m: { type: MovementType; userId: string; reason?: string | null; externalReference?: string | null; reversesId?: string | null },
): Promise<{ id: string; number: number }> {
  const r = await c.query(
    `INSERT INTO stock_movement (movement_type, performed_by, reason, external_reference, reverses_movement_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id, movement_number::int AS number`,
    [m.type, m.userId, m.reason?.trim() || null, m.externalReference?.trim() || null, m.reversesId ?? null],
  );
  return r.rows[0];
}

/**
 * Aplica una variación a un saldo y deja la línea en el movimiento.
 * delta es con signo. En materiales sin control de cantidad, delta es null y
 * `presence` indica si el material queda (true) o desaparece (false) del sitio.
 * Devuelve la cantidad que queda.
 */
export async function applyLine(
  c: pg.PoolClient,
  movement: { id: string },
  lineNo: number,
  l: {
    material: MaterialInfo;
    lotId: string | null;
    containerId: string | null;
    locationId: string | null;
    delta: number | null;
    presence?: boolean;
    counted?: boolean;
  },
): Promise<number | null> {
  const m = l.material;
  const existing = await c.query(
    `SELECT id, quantity::float AS quantity FROM stock_balance
      WHERE material_id = $1 AND lot_id IS NOT DISTINCT FROM $2
        AND container_id IS NOT DISTINCT FROM $3 AND location_id IS NOT DISTINCT FROM $4
      FOR UPDATE`,
    [m.id, l.lotId, l.containerId, l.locationId],
  );
  const row = existing.rows[0] as { id: string; quantity: number | null } | undefined;
  let after: number | null = null;

  if (m.tracking === 'NOT_TRACKED') {
    if (l.presence === false) {
      if (row) await deleteBalance(c, row.id);
    } else if (!row) {
      await c.query(
        `INSERT INTO stock_balance (material_id, lot_id, container_id, location_id, quantity, last_counted_at)
         VALUES ($1, $2, $3, $4, NULL, CASE WHEN $5 THEN now() END)`,
        [m.id, l.lotId, l.containerId, l.locationId, Boolean(l.counted)],
      );
    } else if (l.counted) {
      await c.query(`UPDATE stock_balance SET last_counted_at = now(), needs_recount = false, updated_at = now() WHERE id = $1`, [row.id]);
    }
  } else {
    const delta = round(l.delta ?? 0, m.decimals);
    after = round((row?.quantity ?? 0) + delta, m.decimals);
    if (after < 0) {
      throw conflict(
        `No hay suficiente ${m.description}: hay ${row?.quantity ?? 0} ${m.unitCode}`,
        'STOCK_INSUFICIENTE',
      );
    }
    if (!row) {
      await c.query(
        `INSERT INTO stock_balance (material_id, lot_id, container_id, location_id, quantity, last_counted_at)
         VALUES ($1, $2, $3, $4, $5, CASE WHEN $6 THEN now() END)`,
        [m.id, l.lotId, l.containerId, l.locationId, after, Boolean(l.counted)],
      );
    } else if (after === 0 && m.tracking === 'EXACT') {
      // Un saldo exacto que se queda a cero desaparece: ya no hay nada en ese sitio.
      await deleteBalance(c, row.id);
    } else {
      await c.query(
        `UPDATE stock_balance
            SET quantity = $2, updated_at = now(),
                last_counted_at = CASE WHEN $3 THEN now() ELSE last_counted_at END,
                needs_recount = CASE WHEN $3 THEN false
                                     WHEN $4 THEN true ELSE needs_recount END
          WHERE id = $1`,
        // Un estimado que llega a cero probablemente no esté a cero: se pide recuento.
        [row.id, after, Boolean(l.counted), m.tracking === 'ESTIMATED' && after === 0],
      );
    }
  }

  await c.query(
    `INSERT INTO stock_movement_line
       (movement_id, line_no, material_id, lot_id, container_id, location_id,
        quantity_delta, quantity_after, quantity_tracking)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [movement.id, lineNo, m.id, l.lotId, l.containerId, l.locationId,
      m.tracking === 'NOT_TRACKED' ? null : round(l.delta ?? 0, m.decimals), after, m.tracking],
  );
  return after;
}

async function deleteBalance(c: pg.PoolClient, id: string) {
  const a = await c.query(`SELECT 1 FROM stock_allocation WHERE stock_balance_id = $1 AND quantity > 0 LIMIT 1`, [id]);
  if (a.rowCount) {
    throw conflict('Ese material tiene cantidad asignada a un proyecto y no puede vaciarse así', 'STOCK_ASIGNADO');
  }
  await c.query(`DELETE FROM stock_allocation WHERE stock_balance_id = $1`, [id]);
  await c.query(`DELETE FROM stock_balance WHERE id = $1`, [id]);
}

const round = (n: number, decimals: number) => {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
};

/**
 * Si el contenedor es desechable y se ha quedado vacío, devuelve su código para
 * proponer retirarlo. No se retira solo: así una retirada por error se puede revertir.
 */
export async function emptyDisposable(c: pg.PoolClient, containerId: string | null): Promise<string | null> {
  if (!containerId) return null;
  const r = await c.query(
    `SELECT code FROM container
      WHERE id = $1 AND status = 'ACTIVE' AND reuse_policy = 'DISPOSABLE'
        AND NOT EXISTS (SELECT 1 FROM container k WHERE k.parent_container_id = container.id AND k.status = 'ACTIVE')
        AND NOT EXISTS (SELECT 1 FROM stock_balance b WHERE b.container_id = container.id)`,
    [containerId],
  );
  return r.rows[0]?.code ?? null;
}

export async function placeCode(c: pg.PoolClient | pg.Pool, containerId: string | null, locationId: string | null) {
  const r = containerId
    ? await c.query(`SELECT code FROM container WHERE id = $1`, [containerId])
    : await c.query(`SELECT code FROM storage_location WHERE id = $1`, [locationId]);
  return (r.rows[0]?.code as string) ?? '—';
}
