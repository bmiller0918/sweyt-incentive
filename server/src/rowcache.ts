// Materializes an import's rows — its own columns plus columns contributed
// by linked imports — and keeps recently used imports in memory so filter
// previews don't re-read Postgres on every keystroke. Invalidated when
// column types or links change, or an import is deleted.
import {
  aggregateLabel,
  coerceRow,
  inferColumnType,
  summarize,
  type Aggregate,
  type ColumnDef,
  type ColumnType,
  type RawRow,
  type TypedRow,
} from '@commissions/shared';
import { asc, eq, or } from 'drizzle-orm';
import type { Db } from './db/client.js';
import { importLinks, importRows, imports } from './db/schema.js';

export interface LinkedColumn extends ColumnDef {
  /** Name of the import this column comes from. */
  linked: string;
}

export interface CachedImport {
  importId: string;
  /** Own columns followed by linked ones. */
  columns: (ColumnDef | LinkedColumn)[];
  types: Record<string, ColumnType>;
  raw: RawRow[];
  typed: TypedRow[];
}

const MAX_ENTRIES = 8;
const cache = new Map<string, CachedImport>();
/** Raw own rows per import, so linked imports aren't re-read for every materialization. */
const rawCache = new Map<string, RawRow[]>();

export function typesOf(columns: ColumnDef[]): Record<string, ColumnType> {
  return Object.fromEntries(columns.map((c) => [c.name, c.type]));
}

/** Join keys match after trimming, case-insensitively. */
const keyOf = (v: string | undefined) => (v ?? '').trim().toLowerCase();

async function ownRows(db: Db, importId: string): Promise<RawRow[]> {
  const hit = rawCache.get(importId);
  if (hit) return hit;
  const rows = (
    await db.select({ data: importRows.data }).from(importRows).where(eq(importRows.importId, importId)).orderBy(asc(importRows.rowIndex))
  ).map((r) => r.data);
  rawCache.set(importId, rows);
  return rows;
}

function unique(name: string, taken: Set<string>): string {
  let n = name;
  let i = 2;
  while (taken.has(n)) n = `${name} (${i++})`;
  taken.add(n);
  return n;
}

/**
 * Build the materialized view of an import: own rows, plus parent fields
 * (if it is a child) and child roll-ups (if it is a parent).
 */
async function materialize(db: Db, imp: typeof imports.$inferSelect): Promise<CachedImport> {
  const columns: (ColumnDef | LinkedColumn)[] = [...imp.columns];
  const taken = new Set(columns.map((c) => c.name));
  const raw = (await ownRows(db, imp.id)).map((r) => ({ ...r }));

  const links = await db
    .select()
    .from(importLinks)
    .where(or(eq(importLinks.childImportId, imp.id), eq(importLinks.parentImportId, imp.id)));

  // -- As a child: bring the parent's fields down ----------------------------
  const asChild = links.find((l) => l.childImportId === imp.id);
  if (asChild) {
    const [parent] = await db.select().from(imports).where(eq(imports.id, asChild.parentImportId));
    if (parent) {
      const prows = await ownRows(db, parent.id);
      const byKey = new Map<string, RawRow>();
      for (const r of prows) {
        const k = keyOf(r[asChild.parentKey]);
        if (k && !byKey.has(k)) byKey.set(k, r); // first match wins
      }
      const fields = (asChild.parentFields.length ? asChild.parentFields : parent.columns.map((c) => c.name)).filter((f) => f !== asChild.parentKey);
      for (const f of fields) {
        const pc = parent.columns.find((c) => c.name === f);
        if (!pc) continue;
        const name = unique(`${parent.name}: ${f}`, taken);
        columns.push({ name, index: columns.length, type: pc.type, inferredType: pc.inferredType, linked: parent.name });
        for (const r of raw) r[name] = byKey.get(keyOf(r[asChild.childKey]))?.[f] ?? '';
      }
    }
  }

  // -- As a parent: roll each child's rows up ------------------------------
  for (const link of links.filter((l) => l.parentImportId === imp.id)) {
    const [child] = await db.select().from(imports).where(eq(imports.id, link.childImportId));
    if (!child || !link.aggregates.length) continue;
    const crows = await ownRows(db, child.id);
    const ctypes = typesOf(child.columns);
    const ctyped = crows.map((r) => coerceRow(r, ctypes));
    // Group child rows by the key (normalized), then read each aggregate back.
    const keyCol = '__key';
    const keyed = crows.map((r, i) => ({ ...r, [keyCol]: keyOf(r[link.childKey]) }));
    const keyedTyped = ctyped.map((t, i) => ({ ...t, [keyCol]: keyed[i][keyCol] }));
    const spec = { groupBy: [keyCol], aggregates: link.aggregates as Aggregate[] };
    const s = summarize(keyed, keyedTyped, keyed.map((_, i) => i), spec, { types: { ...ctypes, [keyCol]: 'text' } });
    const outCols = s.columns.slice(1); // drop the key column
    const byKey = new Map(s.raw.map((r) => [r[keyCol], r]));
    outCols.forEach((oc, j) => {
      const label = aggregateLabel(link.aggregates[j] as Aggregate);
      const name = unique(`${child.name}: ${label}`, taken);
      columns.push({ name, index: columns.length, type: oc.type, inferredType: oc.type, linked: child.name });
      for (const r of raw) {
        const hit = byKey.get(keyOf(r[link.parentKey]));
        r[name] = hit ? (hit[oc.name] ?? '') : link.aggregates[j].fn === 'count' ? '0' : '';
      }
    });
  }

  // Linked columns keep their source types; anything unknown gets inferred.
  for (const c of columns) if (!c.type) c.type = c.inferredType = inferColumnType(raw.map((r) => r[c.name] ?? ''));
  const types = typesOf(columns);
  return { importId: imp.id, columns, types, raw, typed: raw.map((r) => coerceRow(r, types)) };
}

export async function getRows(db: Db, imp: typeof imports.$inferSelect): Promise<CachedImport> {
  const hit = cache.get(imp.id);
  const ownTypes = JSON.stringify(typesOf(imp.columns));
  if (hit && (hit as CachedImport & { ownTypes?: string }).ownTypes === ownTypes) {
    cache.delete(imp.id);
    cache.set(imp.id, hit);
    return hit;
  }
  const entry = await materialize(db, imp);
  (entry as CachedImport & { ownTypes?: string }).ownTypes = ownTypes;
  cache.set(imp.id, entry);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  return entry;
}

/** Drop one import's materialized rows (and anything that may include them). */
export function invalidate(importId: string) {
  cache.delete(importId);
  rawCache.delete(importId);
  // Links mean another import may embed this one's data; be conservative.
  cache.clear();
}

export function invalidateAll() {
  cache.clear();
  rawCache.clear();
}
