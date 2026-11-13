import type pg from 'pg';

type Db = pg.Pool | pg.PoolClient;

export const LOCATION_SELECT = `
  SELECT l.id, l.code, l.name, l.description, l.parent_id AS "parentId", l.qr_token AS "qrToken",
         t.code AS "typeCode", t.name AS "typeName",
         l.max_capacity::float AS "maxCapacity", l.allowed_hazard_classes AS "allowedHazardClasses",
         l.restrictions_note AS "restrictionsNote", l.active,
         (SELECT count(*)::int FROM storage_location c WHERE c.parent_id = l.id AND c.active) AS "childCount",
         (SELECT count(*)::int FROM container c WHERE c.location_id = l.id AND c.status = 'ACTIVE') AS "containerCount"
    FROM storage_location l
    JOIN location_type t ON t.id = l.location_type_id`;

export const CONTAINER_SELECT = `
  SELECT c.id, c.code, c.qr_token AS "qrToken", c.status, c.reuse_policy AS "reusePolicy",
         c.description, c.location_id AS "locationId", c.parent_container_id AS "parentContainerId",
         c.responsible_user_id AS "responsibleUserId", ru.full_name AS "responsibleName",
         t.code AS "typeCode", t.name AS "typeName",
         c.created_at AS "createdAt", c.retired_at AS "retiredAt",
         (SELECT count(*)::int FROM container k WHERE k.parent_container_id = c.id AND k.status = 'ACTIVE') AS "childCount"
    FROM container c
    JOIN container_type t ON t.id = c.container_type_id
    LEFT JOIN app_user ru ON ru.id = c.responsible_user_id`;

/** Cadena de ubicaciones desde la raíz hasta la indicada (incluida). */
export async function locationPath(db: Db, locationId: string) {
  const r = await db.query(
    `WITH RECURSIVE up AS (
       SELECT id, code, name, parent_id, 0 AS depth FROM storage_location WHERE id = $1
       UNION ALL
       SELECT l.id, l.code, l.name, l.parent_id, up.depth + 1
         FROM storage_location l JOIN up ON l.id = up.parent_id
     )
     SELECT id, code, name FROM up ORDER BY depth DESC`,
    [locationId],
  );
  return r.rows as Array<{ id: string; code: string; name: string }>;
}

/** Cadena de contenedores desde el raíz hasta el indicado (incluido). */
export async function containerChain(db: Db, containerId: string) {
  const r = await db.query(
    `WITH RECURSIVE up AS (
       SELECT id, code, parent_container_id, location_id, 0 AS depth FROM container WHERE id = $1
       UNION ALL
       SELECT c.id, c.code, c.parent_container_id, c.location_id, up.depth + 1
         FROM container c JOIN up ON c.id = up.parent_container_id
     )
     SELECT id, code, location_id AS "locationId" FROM up ORDER BY depth DESC`,
    [containerId],
  );
  return r.rows as Array<{ id: string; code: string; locationId: string | null }>;
}

/** Número de contenedores que cuelgan del indicado, a cualquier profundidad. */
export async function descendantCount(db: Db, containerId: string): Promise<number> {
  const r = await db.query(
    `WITH RECURSIVE down AS (
       SELECT id FROM container WHERE parent_container_id = $1
       UNION ALL
       SELECT c.id FROM container c JOIN down ON c.parent_container_id = down.id
     )
     SELECT count(*)::int AS n FROM down`,
    [containerId],
  );
  return r.rows[0].n;
}

export async function getParameter<T>(db: Db, key: string, fallback: T): Promise<T> {
  const r = await db.query(`SELECT value FROM system_parameter WHERE key = $1`, [key]);
  return r.rowCount ? (r.rows[0].value as T) : fallback;
}
