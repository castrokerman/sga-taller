import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { AppError, badRequest } from './errors.js';

/**
 * Evita que una operación se registre dos veces cuando el móvil la reenvía
 * por mala cobertura.
 *
 * La web manda una clave única por operación en la cabecera Idempotency-Key.
 * Si llega una segunda petición con la misma clave, no se ejecuta nada:
 * se devuelve la respuesta que se dio la primera vez.
 */
export async function idempotent<T>(
  pool: pg.Pool,
  request: FastifyRequest,
  reply: FastifyReply,
  handler: () => Promise<T>,
): Promise<T> {
  const key = request.headers['idempotency-key'];
  if (typeof key !== 'string' || key.length < 8 || key.length > 100) {
    throw badRequest('Falta la clave de la operación', 'FALTA_CLAVE_IDEMPOTENCIA');
  }
  const hash = createHash('sha256')
    .update(`${request.method} ${request.url} ${JSON.stringify(request.body ?? null)}`)
    .digest('hex');

  const inserted = await pool.query(
    `INSERT INTO idempotency_key (key, user_id, endpoint, request_hash)
     VALUES ($1, $2, $3, $4) ON CONFLICT (key) DO NOTHING RETURNING key`,
    [key, request.user!.id, `${request.method} ${request.routeOptions.url ?? request.url}`, hash],
  );

  if (!inserted.rowCount) {
    const existing = await pool.query(
      `SELECT user_id, request_hash, response_code, response_body, completed_at FROM idempotency_key WHERE key = $1`,
      [key],
    );
    const row = existing.rows[0];
    if (!row || row.user_id !== request.user!.id || row.request_hash !== hash) {
      throw new AppError(422, 'CLAVE_REUTILIZADA', 'La clave de la operación ya se usó para otra operación distinta');
    }
    if (!row.completed_at) {
      throw new AppError(409, 'OPERACION_EN_CURSO', 'La operación ya se está procesando. Espera un momento');
    }
    reply.code(row.response_code).header('idempotent-replay', 'true');
    return row.response_body as T;
  }

  try {
    const result = await handler();
    await pool.query(
      `UPDATE idempotency_key SET response_code = $2, response_body = $3, completed_at = now() WHERE key = $1`,
      [key, reply.statusCode, JSON.stringify(result)],
    );
    return result;
  } catch (error) {
    // Si la operación falla no queda registrada: se puede reintentar con la misma clave.
    await pool.query(`DELETE FROM idempotency_key WHERE key = $1`, [key]).catch(() => undefined);
    throw error;
  }
}
