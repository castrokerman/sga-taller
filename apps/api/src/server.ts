import pg from 'pg';
import { buildApp } from './app.js';
import { ensureFirstAdmin, seedDemoUsers } from './bootstrap.js';
import { loadConfig } from './config.js';
import { runMigrations } from './db/migrate.js';
import { notifyDueDepartures } from './routes/departures.js';

async function main() {
  const config = loadConfig();

  const migrations = await runMigrations(config.databaseUrl);
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
  const app = await buildApp({ pool, config });

  app.log.info({ nuevas: migrations.applied }, 'migraciones al día');
  app.log.info({ resultado: await ensureFirstAdmin(pool, config) }, 'primer administrador');
  if (config.seedDemo) app.log.info({ creados: await seedDemoUsers(pool) }, 'usuarios de demostración');

  // Limpieza periódica de sesiones caducadas y claves de idempotencia antiguas.
  const cleanup = setInterval(() => {
    pool
      .query(`DELETE FROM user_session WHERE expires_at < now() - interval '7 days'`)
      .catch((err) => app.log.error({ err }, 'fallo en la limpieza de sesiones'));
  }, 60 * 60 * 1000);
  cleanup.unref();

  // Salidas temporales vencidas: aviso al responsable para que diga si ha vuelto.
  const due = () => notifyDueDepartures(pool).catch((err) => app.log.error({ err }, 'fallo al revisar salidas vencidas'));
  void due();
  const dueTimer = setInterval(due, 10 * 60 * 1000);
  dueTimer.unref();

  const shutdown = async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  await app.listen({ port: config.port, host: config.host });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
