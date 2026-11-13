import type pg from 'pg';

export interface AuditEntry {
  userId?: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  before?: unknown;
  after?: unknown;
  ip?: string;
  requestId?: string;
}

/** Añade una línea al registro de auditoría. El registro solo admite altas. */
export async function writeAudit(db: pg.Pool | pg.PoolClient, e: AuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO audit_log (user_id, action, entity_type, entity_id, before_data, after_data, ip, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      e.userId ?? null,
      e.action,
      e.entityType ?? null,
      e.entityId ?? null,
      e.before === undefined ? null : JSON.stringify(e.before),
      e.after === undefined ? null : JSON.stringify(e.after),
      e.ip ?? null,
      e.requestId ?? null,
    ],
  );
}
