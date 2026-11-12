/**
 * Ejecutor de migraciones del SGA.
 *
 * - Aplica en orden los ficheros .sql de la carpeta migrations.
 * - Cada migración se ejecuta en una transacción: o entra entera o no entra.
 * - Guarda en schema_migrations qué se ha aplicado y la huella del fichero.
 * - Si un fichero ya aplicado ha cambiado, se detiene: las migraciones
 *   aplicadas no se editan, se añade una nueva.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

const DEFAULT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
const LOCK_ID = 7421001; // candado para que dos arranques no migren a la vez

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function runMigrations(connectionString: string, dir: string = DEFAULT_DIR): Promise<MigrationResult> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const result: MigrationResult = { applied: [], skipped: [] };

  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name       text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const done = new Map<string, string>(
      (await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations')).rows.map(
        (r) => [r.name, r.checksum],
      ),
    );

    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      const sql = await readFile(path.join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = done.get(file);

      if (previous !== undefined) {
        if (previous !== checksum) {
          throw new Error(
            `La migración ${file} ya está aplicada pero su contenido ha cambiado. ` +
              'No edites migraciones aplicadas: crea una nueva.',
          );
        }
        result.skipped.push(file);
        continue;
      }

      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
        result.applied.push(file);
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`Fallo al aplicar ${file}: ${(error as Error).message}`, { cause: error });
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]).catch(() => undefined);
    await client.end();
  }

  return result;
}

// Uso desde la línea de comandos: npm run migrate
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('Falta la variable de entorno DATABASE_URL');
    process.exit(1);
  }
  runMigrations(url)
    .then((r) => {
      for (const f of r.applied) console.log(`aplicada   ${f}`);
      for (const f of r.skipped) console.log(`ya estaba  ${f}`);
      console.log(`Migraciones al día (${r.applied.length} nuevas, ${r.skipped.length} ya aplicadas).`);
    })
    .catch((e: Error) => {
      console.error(e.message);
      process.exit(1);
    });
}
