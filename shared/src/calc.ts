// Stage 3: evaluate formulas per summary row, with each rep's comp-plan
// parameters exposed as `plan.<name>`. Appends output columns to the summary
// so the grid, totals, export and HAVING-style tooling see ordinary columns.
import { parseDate } from './coerce.js';
import type { CalcSpec, CriteriaNode } from './criteria.js';
import { resolveRelativeRange, type DateContext } from './dates.js';
import { FormulaError, compileFormula, type CompiledFormula, type FormulaValue, type Scope } from './formula.js';
import type { SummaryResult } from './summary.js';
import type { ColumnDef, ColumnType, RawRow, TypedRow } from './types.js';

export type PlanParams = Record<string, number | string | boolean | null>;

export interface ResolvedPlan {
  planName: string;
  params: PlanParams;
}

/** Finds the plan in force for a rep name (already trimmed), or null. */
export type PlanLookup = (repName: string) => ResolvedPlan | null;

export const PLAN_COLUMN = 'Plan';

export interface CalcResult extends SummaryResult {
  /** Per-item compile errors, keyed by item id. */
  errors: Record<string, string>;
  /** Summary rows whose rep had no plan assignment. */
  noPlan: number;
}

function unique(name: string, taken: Set<string>): string {
  let n = name;
  let i = 2;
  while (taken.has(n)) n = `${name} (${i++})`;
  taken.add(n);
  return n;
}

function formatOut(v: FormulaValue): string {
  if (v === null) return '';
  if (typeof v === 'number') return String(Math.round(v * 1e6) / 1e6);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return v;
}

export function applyCalc(res: SummaryResult, calc: CalcSpec, lookup: PlanLookup | null): CalcResult {
  const columns: ColumnDef[] = [...res.columns];
  const taken = new Set(columns.map((c) => c.name));
  const raw: RawRow[] = res.raw.map((r) => ({ ...r }));
  const typed: TypedRow[] = res.typed.map((r) => ({ ...r }));
  const errors: Record<string, string> = {};
  let noPlan = 0;

  // Resolve each row's plan once.
  const plans: (ResolvedPlan | null)[] = res.typed.map((row, i) => {
    if (!calc.repField || !lookup) return null;
    const rep = String(raw[i][calc.repField] ?? '').trim();
    const p = rep ? lookup(rep) : null;
    if (!p) noPlan++;
    return p;
  });

  if (calc.repField && lookup) {
    const name = unique(PLAN_COLUMN, taken);
    columns.push({ name, index: columns.length, type: 'text', inferredType: 'text' });
    plans.forEach((p, i) => {
      raw[i][name] = p?.planName ?? '';
      typed[i][name] = p?.planName ?? null;
    });
  }

  // Compile every formula up front; later items may reference earlier labels.
  const known: string[] = columns.map((c) => c.name);
  const compiled: { item: CalcSpec['items'][number]; fn: CompiledFormula | null; name: string }[] = [];
  for (const item of calc.items) {
    const name = unique(item.label.trim() || 'Calc', taken);
    let fn: CompiledFormula | null = null;
    try {
      fn = compileFormula(item.formula, known);
    } catch (e) {
      errors[item.id] = e instanceof FormulaError ? e.message : String(e);
    }
    compiled.push({ item, fn, name });
    known.push(name);
  }

  for (const { fn, name } of compiled) {
    const values: FormulaValue[] = typed.map((row, i) => {
      if (!fn) return null;
      const scope: Scope = { ...(row as Record<string, FormulaValue>), plan: plans[i]?.params ?? {} };
      try {
        return fn.evaluate(scope);
      } catch {
        return null;
      }
    });
    const allNumeric = values.every((v) => v === null || typeof v === 'number');
    const type: ColumnType = allNumeric ? 'decimal' : 'text';
    columns.push({ name, index: columns.length, type, inferredType: type });
    values.forEach((v, i) => {
      raw[i][name] = formatOut(v);
      typed[i][name] = v;
    });
  }

  return { columns, raw, typed, groupCount: res.groupCount, errors, noPlan };
}

/**
 * The "as of" date for plan lookup: the end of the period filter when one
 * is set (a condition whose id starts with "period:"), else today.
 */
export function asOfFromCriteria(criteria: { root: { children: CriteriaNode[] } }, ctx: DateContext, today = Date.now()): string {
  const toIso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const node = criteria.root.children.find((c) => c.type === 'condition' && c.id.startsWith('period:'));
  if (node && node.type === 'condition') {
    const v = node.values[0];
    if ((node.operator === 'relative' || node.operator === 'not_relative') && v?.kind === 'relative') {
      return toIso(resolveRelativeRange(v.preset, v.n, { ...ctx, now: today })[1]);
    }
    if (node.operator === 'between' || node.operator === 'on_or_before' || node.operator === 'before') {
      const ends = node.values.flatMap((x) => (x.kind === 'literal' ? [parseDate(x.value)] : [])).filter((n): n is number => n !== null);
      if (ends.length) return toIso(Math.max(...ends));
    }
  }
  return toIso(today);
}

/**
 * Build a lookup from plan assignments. Rep names match case-insensitively
 * after trimming; when several assignments cover the as-of date, the one
 * with the latest start wins.
 */
export function makePlanLookup(
  assignments: { repName: string; planName: string; params: PlanParams; effectiveFrom: string | null; effectiveTo: string | null }[],
  asOf: string,
): PlanLookup {
  const byRep = new Map<string, typeof assignments>();
  for (const a of assignments) {
    const k = a.repName.trim().toLowerCase();
    const list = byRep.get(k) ?? [];
    list.push(a);
    byRep.set(k, list);
  }
  return (rep) => {
    const list = byRep.get(rep.trim().toLowerCase());
    if (!list) return null;
    const live = list.filter((a) => (!a.effectiveFrom || a.effectiveFrom <= asOf) && (!a.effectiveTo || a.effectiveTo >= asOf));
    if (!live.length) return null;
    live.sort((a, b) => (b.effectiveFrom ?? '').localeCompare(a.effectiveFrom ?? ''));
    return { planName: live[0].planName, params: live[0].params };
  };
}
