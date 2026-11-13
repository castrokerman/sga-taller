import type pg from 'pg';
import { CONTAINER_SELECT, containerChain, locationPath } from './queries.js';

type Db = pg.Pool | pg.PoolClient;

/** Ficha completa de un contenedor: dónde está, qué lleva dentro y su historial. */
export async function containerDetail(db: Db, id: string) {
  const found = await db.query(`${CONTAINER_SELECT} WHERE c.id = $1`, [id]);
  const container = found.rows[0];
  if (!container) return null;

  const chain = await containerChain(db, id);
  const rootLocationId = chain[0]?.locationId ?? null;

  const [path, children, content, movements] = await Promise.all([
    rootLocationId ? locationPath(db, rootLocationId) : Promise.resolve([]),
    db.query(`${CONTAINER_SELECT} WHERE c.parent_container_id = $1 AND c.status = 'ACTIVE' ORDER BY c.code`, [id]),
    db.query(
      `SELECT stock_balance_id AS "stockBalanceId", material_id AS "materialId", internal_ref AS "internalRef",
              description, unit_code AS "unitCode", quantity_tracking AS "quantityTracking",
              lot_id AS "lotId", lot_code AS "lotCode", quantity::float AS quantity, needs_recount AS "needsRecount"
         FROM container_content WHERE container_id = $1 ORDER BY internal_ref, lot_code`,
      [id],
    ),
    db.query(
      `SELECT m.movement_number::int AS "movementNumber", m.movement_type AS "movementType",
              m.performed_at AS "performedAt", u.full_name AS "performedBy", m.reason,
              fl.code AS "fromLocation", fp.code AS "fromContainer",
              tl.code AS "toLocation", tp.code AS "toContainer"
         FROM stock_movement_line l
         JOIN stock_movement m ON m.id = l.movement_id
         JOIN app_user u ON u.id = m.performed_by
         LEFT JOIN storage_location fl ON fl.id = l.from_location_id
         LEFT JOIN container fp ON fp.id = l.from_parent_container_id
         LEFT JOIN storage_location tl ON tl.id = l.to_location_id
         LEFT JOIN container tp ON tp.id = l.to_parent_container_id
        WHERE l.moved_container_id = $1
        ORDER BY m.movement_number DESC LIMIT 30`,
      [id],
    ),
  ]);

  return {
    container,
    // Contenedores que lo envuelven, del más exterior al propio contenedor.
    containerPath: chain.map(({ id: cid, code }) => ({ id: cid, code })),
    // Ubicaciones desde la raíz hasta donde está el contenedor exterior.
    locationPath: path,
    children: children.rows,
    content: content.rows,
    movements: movements.rows,
  };
}

/** Anota en el historial un cambio de sitio de un contenedor. */
export async function recordContainerMove(
  c: pg.PoolClient,
  m: {
    userId: string;
    containerId: string;
    fromLocationId: string | null;
    fromParentId: string | null;
    toLocationId: string | null;
    toParentId: string | null;
    reason?: string | null;
    idempotencyKey?: string | null;
  },
): Promise<number> {
  const movement = await c.query(
    `INSERT INTO stock_movement (movement_type, performed_by, reason, idempotency_key)
     VALUES ('CONTAINER_MOVE', $1, $2, $3) RETURNING id, movement_number::int AS n`,
    [m.userId, m.reason ?? null, m.idempotencyKey ?? null],
  );
  await c.query(
    `INSERT INTO stock_movement_line
       (movement_id, line_no, moved_container_id, from_location_id, from_parent_container_id,
        to_location_id, to_parent_container_id)
     VALUES ($1, 1, $2, $3, $4, $5, $6)`,
    [movement.rows[0].id, m.containerId, m.fromLocationId, m.fromParentId, m.toLocationId, m.toParentId],
  );
  return movement.rows[0].n;
}
