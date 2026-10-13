// Picks the database driver from the environment:
//   DATABASE_URL set  -> real Postgres (Railway plugin, local server, ...)
//   otherwise         -> PGlite, an embedded Postgres persisted to ./data
// Both run the same migrations and expose the same Drizzle API.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import * as schema from './schema.js';

export type Db = PgDatabase<any, typeof schema>;

const here = path.dirname(fileURLToPath(import.meta.url));

/** Works both from src/ (tsx) and from the bundled dist/index.js. */
export function migrationsFolder(): string {
  const candidates = [path.resolve(here, '../../drizzle'), path.resolve(here, '../drizzle')];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error(`Migrations folder not found; looked in ${candidates.join(', ')}`);
  return found;
}

export async function createDb(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const { migrate } = await import('drizzle-orm/node-postgres/migrator');
    const pg = await import('pg');
    const pool = new pg.default.Pool({
      connectionString: url,
      ssl: url.includes('railway') || process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
    });
    const db = drizzle(pool, { schema });
    await migrate(db, { migrationsFolder: migrationsFolder() });
    console.log('[db] connected to Postgres');
    return db as unknown as Db;
  }

  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const { migrate } = await import('drizzle-orm/pglite/migrator');
  const dataDir = process.env.PGLITE_DATA_DIR ?? path.resolve(process.cwd(), 'data/pglite');
  fs.mkdirSync(dataDir, { recursive: true });
  const client = new PGlite(dataDir);
  const db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: migrationsFolder() });
  console.log(`[db] using embedded PGlite at ${dataDir}`);
  return db as unknown as Db;
}
