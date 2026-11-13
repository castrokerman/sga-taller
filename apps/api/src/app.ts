import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type pg from 'pg';
import { findSessionUser } from './auth/sessions.js';
import type { Config } from './config.js';
import { AppError } from './errors.js';
import { adminRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function buildApp(deps: { pool: pg.Pool; config: Config }): Promise<FastifyInstance> {
  const { pool, config } = deps;

  const app = Fastify({
    logger: config.logLevel === 'silent' ? false : { level: config.logLevel, redact: ['req.headers.cookie'] },
    trustProxy: true, // detrás del proxy HTTPS
    bodyLimit: 1024 * 1024,
    ajv: { customOptions: { coerceTypes: true, removeAdditional: false } },
  });

  await app.register(cookie);
  await app.register(rateLimit, {
    global: false,
    errorResponseBuilder: () =>
      new AppError(429, 'DEMASIADAS_PETICIONES', 'Demasiados intentos. Espera un minuto y vuelve a probar'),
  });

  app.decorateRequest('user', null);

  // Identifica al usuario de cada petición a partir de la cookie de sesión.
  app.addHook('onRequest', async (request) => {
    const token = request.cookies[config.cookieName];
    request.user = token ? await findSessionUser(pool, token) : null;
  });

  // Protección frente a peticiones lanzadas desde otras webs (CSRF): toda
  // operación que modifica datos debe traer una cabecera que solo nuestra web envía.
  app.addHook('onRequest', async (request) => {
    if (!SAFE_METHODS.has(request.method) && request.headers['x-sga-client'] !== 'web') {
      throw new AppError(403, 'PETICION_NO_VALIDA', 'Petición no válida');
    }
  });

  app.setErrorHandler((error: FastifyError | AppError, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }
    if ((error as FastifyError).validation) {
      return reply.code(400).send({ error: { code: 'DATOS_NO_VALIDOS', message: 'Los datos enviados no son válidos' } });
    }
    const pgCode = (error as { code?: string }).code;
    if (typeof pgCode === 'string' && /^SG\d{3}$/.test(pgCode)) {
      // Regla de integridad de la base de datos: el mensaje ya está en español.
      return reply.code(409).send({ error: { code: pgCode, message: error.message } });
    }
    const status = (error as FastifyError).statusCode;
    if (status && status >= 400 && status < 500) {
      return reply.code(status).send({ error: { code: 'PETICION_NO_VALIDA', message: 'Petición no válida' } });
    }
    request.log.error({ err: error }, 'error no controlado');
    return reply.code(500).send({ error: { code: 'ERROR_INTERNO', message: 'Ha ocurrido un error inesperado' } });
  });

  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ error: { code: 'NO_ENCONTRADO', message: 'No encontrado' } }),
  );

  app.get('/api/health', async (_request, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'sin_base_de_datos' });
    }
  });

  authRoutes(app, { pool, config });
  adminRoutes(app, { pool });

  return app;
}
