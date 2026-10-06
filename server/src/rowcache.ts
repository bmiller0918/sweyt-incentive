// Keeps typed rows for recently used imports in memory so filter previews
// don't re-read Postgres on every keystroke. Invalidated when column types
// change or the import is deleted.
import { coerceRow, type ColumnDef, type ColumnType, type RawRow, type TypedRow } from '@commissions/shared';
import { asc, eq } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { importRows } from './db/schema.js';

export interface CachedImport {
  importId: string;
  types: Record<string, ColumnType>;
  raw: RawRow[];
  typed: TypedRow[];
}

const MAX_ENTRIES = 8;
const cache = new Map<string, CachedImport>();

export function typesOf(columns: ColumnDef[]): Record<string, ColumnType> {
  return Object.fromEntries(columns.map((c) => [c.name, c.type]));
}

export async function getRows(db: Db, importId: string, columns: ColumnDef[]): Promise<CachedImport> {
  const types = typesOf(columns);
  const hit = cache.get(importId);
  if (hit && JSON.stringify(hit.types) === JSON.stringify(types)) {
    // Refresh LRU order
    cache.delete(importId);
    cache.set(importId, hit);
    return hit;
  }

  const raw = hit
    ? hit.raw
    : (
        await db
          .select({ data: importRows.data })
          .from(importRows)
          .where(eq(importRows.importId, importId))
          .orderBy(asc(importRows.rowIndex))
      ).map((r) => r.data);

  const entry: CachedImport = {
    importId,
    types,
    raw,
    typed: raw.map((r) => coerceRow(r, types)),
  };
  cache.set(importId, entry);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  return entry;
}

export function invalidate(importId: string) {
  cache.delete(importId);
}
