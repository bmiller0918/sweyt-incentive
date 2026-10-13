// Picks the database driver from the environment:
//   DATABASE_URL set  -> real Postgres (Railway plugin, local server, ...)
//   otherwise         -> PGlite, an embedded Postgres persisted to ./data
// Both run the same migrations and expose the same Drizzle API.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import * as schema from './schema.js';

export type Db = PgDatabase<any, typeof schema>;

const here = path.dirname(fileURLToPath(import.meta.url));

/** Works both from src/ (tsx) and from the bundled dist/index.js. */
function migrationsFolder(): string {
  const candidates = [path.resolve(here, '../../drizzle'), path.resolve(here, '../drizzle')];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error(`Migrations folder not found; looked in ${candidates.join(', ')}`);
  return found;
}

/**
 * Apply pending migrations by content hash, using Drizzle's own bookkeeping
 * table (drizzle.__drizzle_migrations: hash + created_at).
 *
 * Drizzle's stock migrate() runs every migration whose journal timestamp is
 * newer than the last applied one. That breaks as soon as two branches each
 * add a migration and one gets renumbered on merge: a database that applied
 * the renumbered file under its old timestamp then skips every older-stamped
 * migration forever (or fails re-creating a table it already has). Keying on
 * the hash instead makes "already applied" mean what it says, whatever the
 * numbering. A migration file must therefore never be edited after it has
 * been applied anywhere; add a new one instead.
 */
/** Arbitrary, app-wide advisory lock key serialising migration runs. */
const MIGRATION_LOCK_KEY = 727274;

export async function runMigrations(db: Db, migrationsFolder: string): Promise<string[]> {
  const migrations = readMigrationFiles({ migrationsFolder });
  await db.execute(sql`CREATE SCHEMA IF NOT EXISTS drizzle`);
  await db.execute(sql`CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
  // The up-front read only skips work; the authoritative check happens under
  // the lock, so two replicas starting together don't both run the same DDL.
  const applied = new Set(((await db.execute(sql`SELECT hash FROM drizzle.__drizzle_migrations`)).rows as { hash: string }[]).map((r) => r.hash));
  const ran: string[] = [];
  for (const m of migrations) {
    if (applied.has(m.hash)) continue;
    const did = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`);
      const dup = await tx.execute(sql`SELECT 1 FROM drizzle.__drizzle_migrations WHERE hash = ${m.hash}`);
      if (dup.rows.length) return false;
      for (const stmt of m.sql) await tx.execute(sql.raw(stmt));
      await tx.execute(sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES (${m.hash}, ${m.folderMillis})`);
      return true;
    });
    if (did) ran.push(m.hash.slice(0, 8));
  }
  return ran;
}

export async function createDb(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (url) {
    const { drizzle } = await import('drizzle-orm/node-postgres');
    const pg = await import('pg');
    const pool = new pg.default.Pool({
      connectionString: url,
      ssl: url.includes('railway') || process.env.PGSSL === 'true' ? { rejectUnauthorized: false } : undefined,
    });
    const db = drizzle(pool, { schema }) as unknown as Db;
    const ran = await runMigrations(db, migrationsFolder());
    console.log(`[db] connected to Postgres${ran.length ? ` (applied ${ran.length} migration${ran.length === 1 ? '' : 's'})` : ''}`);
    return db;
  }

  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const dataDir = process.env.PGLITE_DATA_DIR ?? path.resolve(process.cwd(), 'data/pglite');
  fs.mkdirSync(dataDir, { recursive: true });
  const client = new PGlite(dataDir);
  const db = drizzle(client, { schema }) as unknown as Db;
  const ran = await runMigrations(db, migrationsFolder());
  console.log(`[db] using embedded PGlite at ${dataDir}${ran.length ? ` (applied ${ran.length} migration${ran.length === 1 ? '' : 's'})` : ''}`);
  return db;
}
