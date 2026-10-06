// Second-stage evaluation: group filtered rows and compute aggregates, then
// optionally filter the result (HAVING). Output is shaped like an import
// (columns + raw + typed rows) so the grid, sort, export and criteria
// evaluator all work on it unchanged.
import { formatDateMs } from './coerce.js';
import type { Aggregate, SummarySpec } from './criteria.js';
import { compileCriteria, type EvalContext } from './evaluate.js';
import { familyOf, type ColumnDef, type ColumnType, type RawRow, type TypedRow, type TypedValue } from './types.js';

export interface SummaryResult {
  columns: ColumnDef[];
  raw: RawRow[];
  typed: TypedRow[];
  /** Row count before HAVING was applied. */
  groupCount: number;
}

export function aggregateLabel(a: Aggregate): string {
  if (a.label?.trim()) return a.label.trim();
  if (a.fn === 'count') return 'Count';
  const field = a.field ?? '?';
  switch (a.fn) {
    case 'sum':
      return `Sum of ${field}`;
    case 'avg':
      return `Avg of ${field}`;
    case 'min':
      return `Min of ${field}`;
    case 'max':
      return `Max of ${field}`;
    case 'count_distinct':
      return `Distinct ${field}`;
  }
}

function outputType(a: Aggregate, types: Record<string, ColumnType>): ColumnType {
  const src = a.field ? types[a.field] : undefined;
  switch (a.fn) {
    case 'count':
    case 'count_distinct':
      return 'integer';
    case 'sum':
    case 'avg':
      return src === 'currency' || src === 'percent' ? src : 'decimal';
    case 'min':
    case 'max':
      return src ?? 'text';
  }
}

/**
 * The columns a summary produces, computed without any rows so the UI can
 * build a HAVING editor before the query runs. Names are made unique.
 */
export function summaryColumns(spec: SummarySpec, types: Record<string, ColumnType>): ColumnDef[] {
  const seen = new Map<string, number>();
  const unique = (name: string) => {
    const n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    return n === 0 ? name : `${name} (${n + 1})`;
  };
  const cols: ColumnDef[] = [];
  for (const g of spec.groupBy) {
    const t = types[g] ?? 'text';
    cols.push({ name: unique(g), index: cols.length, type: t, inferredType: t });
  }
  for (const a of spec.aggregates) {
    const t = outputType(a, types);
    cols.push({ name: unique(aggregateLabel(a)), index: cols.length, type: t, inferredType: t });
  }
  return cols;
}

function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

function formatOut(v: TypedValue, type: ColumnType): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' && familyOf(type) === 'date') return formatDateMs(v, type === 'datetime' ? 'datetime' : 'date');
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v);
}

interface Bucket {
  key: string;
  groupRaw: string[];
  groupTyped: TypedValue[];
  rows: number[];
}

export function summarize(
  raw: RawRow[],
  typed: TypedRow[],
  rowIndices: number[],
  spec: SummarySpec,
  ctx: EvalContext,
): SummaryResult {
  const columns = summaryColumns(spec, ctx.types);
  const outTypes: Record<string, ColumnType> = Object.fromEntries(columns.map((c) => [c.name, c.type]));

  // Group. Non-text keys use the typed value so "$1,000" and "1000" (or two
  // date formats) land in the same bucket; text keys are exact.
  const buckets = new Map<string, Bucket>();
  for (const i of rowIndices) {
    const groupTyped = spec.groupBy.map((g) => typed[i][g] ?? null);
    const groupRaw = spec.groupBy.map((g) => (raw[i][g] ?? '').trim());
    const key = spec.groupBy
      .map((g, k) => (familyOf(ctx.types[g] ?? 'text') === 'text' ? groupRaw[k] : String(groupTyped[k])))
      .join('\u0001');
    let b = buckets.get(key);
    if (!b) {
      b = { key, groupRaw, groupTyped, rows: [] };
      buckets.set(key, b);
    }
    b.rows.push(i);
  }

  const outRaw: RawRow[] = [];
  const outTyped: TypedRow[] = [];
  for (const b of buckets.values()) {
    const r: RawRow = {};
    const t: TypedRow = {};
    spec.groupBy.forEach((_, k) => {
      const col = columns[k];
      r[col.name] = b.groupRaw[k];
      t[col.name] = b.groupTyped[k];
    });
    spec.aggregates.forEach((a, k) => {
      const col = columns[spec.groupBy.length + k];
      const v = computeAggregate(a, b.rows, typed);
      t[col.name] = v;
      r[col.name] = formatOut(v, col.type);
    });
    outRaw.push(r);
    outTyped.push(t);
  }
  const groupCount = outRaw.length;

  // HAVING
  if (spec.having && spec.having.children.length > 0) {
    const compiled = compileCriteria({ version: 1, root: spec.having }, { ...ctx, types: outTypes });
    const keep: number[] = [];
    outTyped.forEach((row, i) => {
      if (compiled.matches(row)) keep.push(i);
    });
    return { columns, raw: keep.map((i) => outRaw[i]), typed: keep.map((i) => outTyped[i]), groupCount };
  }
  return { columns, raw: outRaw, typed: outTyped, groupCount };
}

function computeAggregate(a: Aggregate, rows: number[], typed: TypedRow[]): TypedValue {
  if (a.fn === 'count') return rows.length;
  const field = a.field;
  if (!field) return null;
  switch (a.fn) {
    case 'count_distinct': {
      const set = new Set<string>();
      for (const i of rows) {
        const v = typed[i][field];
        if (v !== null && v !== undefined && v !== '') set.add(typeof v === 'string' ? v.trim().toLowerCase() : String(v));
      }
      return set.size;
    }
    case 'sum': {
      let s = 0;
      for (const i of rows) {
        const v = typed[i][field];
        if (typeof v === 'number') s += v;
      }
      return round(s, 6);
    }
    case 'avg': {
      let s = 0;
      let n = 0;
      for (const i of rows) {
        const v = typed[i][field];
        if (typeof v === 'number') {
          s += v;
          n++;
        }
      }
      return n ? round(s / n, 6) : null;
    }
    case 'min':
    case 'max': {
      let best: TypedValue = null;
      for (const i of rows) {
        const v = typed[i][field];
        if (v === null || v === undefined || v === '') continue;
        if (best === null) best = v;
        else if (typeof v === 'number' && typeof best === 'number') best = a.fn === 'min' ? Math.min(best, v) : Math.max(best, v);
        else if (typeof v === 'string' && typeof best === 'string') {
          const c = v.localeCompare(best, undefined, { numeric: true, sensitivity: 'base' });
          if ((a.fn === 'min' && c < 0) || (a.fn === 'max' && c > 0)) best = v;
        }
      }
      return best;
    }
  }
  return null;
}

/** Sum and non-blank count for every numeric column — the detail totals bar. */
export function columnTotals(
  typed: TypedRow[],
  rowIndices: number[],
  types: Record<string, ColumnType>,
): Record<string, { sum: number; count: number }> {
  const out: Record<string, { sum: number; count: number }> = {};
  const numeric = Object.keys(types).filter((k) => familyOf(types[k]) === 'number');
  for (const k of numeric) out[k] = { sum: 0, count: 0 };
  for (const i of rowIndices) {
    const row = typed[i];
    for (const k of numeric) {
      const v = row[k];
      if (typeof v === 'number') {
        out[k].sum += v;
        out[k].count++;
      }
    }
  }
  for (const k of numeric) out[k].sum = round(out[k].sum, 6);
  return out;
}
