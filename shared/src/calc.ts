// Stage 3: evaluate formulas per summary row, with each rep's comp-plan
// parameters exposed as `plan.<name>`. Appends output columns to the summary
// so the grid, totals, export and HAVING-style tooling see ordinary columns.
import { parseDate } from './coerce.js';
import type { CalcSpec, CriteriaNode } from './criteria.js';
import { resolveRelativeRange, type DateContext } from './dates.js';
import { FormulaError, compileFormula, type CompiledFormula, type FormulaValue, type Scope } from './formula.js';
import type { SummaryResult } from './summary.js';
import { resolveStructure, type PlanStructure } from './components.js';
import type { PlanTiers } from './tiers.js';
import type { ColumnDef, ColumnType, RawRow, TypedRow } from './types.js';

export type PlanParams = Record<string, number | string | boolean | null>;

export interface ResolvedPlan {
  planName: string;
  params: PlanParams;
  /** Tier table for TIER() / TIER_RATE(); optional. */
  tiers?: PlanTiers;
  /** Weighted components for COMPONENT() / COMPONENT_RATE(); optional. */
  structure?: PlanStructure;
}

export interface EmployeeInfo {
  name: string;
  /** active | terminated | parental_leave | ... — exposed as employee.status */
  status?: string;
  /** Employee type name, exposed as employee.type */
  type?: string | null;
  baseSalary: number | null;
  /** Effective quota (employee > type default); overrides plan.quota when set. */
  quota?: number | null;
  /** label -> amount */
  bonuses: Record<string, number>;
}

/** What a formula can see for one rep: the employee record and a plan per slot. */
export interface ResolvedRep {
  employee: EmployeeInfo;
  /** slot name ("plan", "spiff", ...) -> the plan in force for that slot. */
  plans: Record<string, ResolvedPlan>;
}

/** Finds the employee + plans in force for a rep name (already trimmed), or null. */
export type PlanLookup = (repName: string) => ResolvedRep | null;

export const PLAN_COLUMN = 'Plan';
export const DEFAULT_SLOT = 'plan';

/** "Q4 SPIFF bonus" -> "q4_spiff_bonus", so bonuses are addressable as employee.<key>. */
export function scopeKey(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

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

  // Resolve each row's employee + plans once.
  const reps: (ResolvedRep | null)[] = res.typed.map((_, i) => {
    if (!calc.repField || !lookup) return null;
    const rep = String(raw[i][calc.repField] ?? '').trim();
    const r = rep ? lookup(rep) : null;
    if (!r || Object.keys(r.plans).length === 0) noPlan++;
    return r;
  });

  if (calc.repField && lookup) {
    const name = unique(PLAN_COLUMN, taken);
    columns.push({ name, index: columns.length, type: 'text', inferredType: 'text' });
    reps.forEach((r, i) => {
      const label = r
        ? Object.entries(r.plans)
            .sort(([a], [b]) => (a === DEFAULT_SLOT ? -1 : b === DEFAULT_SLOT ? 1 : a.localeCompare(b)))
            .map(([slot, p]) => (slot === DEFAULT_SLOT ? p.planName : `${p.planName} (${slot})`))
            .join(' + ')
        : '';
      raw[i][name] = label;
      typed[i][name] = label || null;
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
      const scope: Scope = { ...(row as Record<string, FormulaValue>), ...repScope(reps[i]) };
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

/** Namespaces a formula can reference for one rep: employee.*, plan.*, <slot>.* */
export function repScope(r: ResolvedRep | null): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = { plan: {}, employee: {} };
  if (!r) return out;
  const bonusTotal = Object.values(r.employee.bonuses).reduce((a, b) => a + b, 0);
  out.employee = {
    name: r.employee.name,
    status: r.employee.status ?? 'active',
    type: r.employee.type ?? null,
    base_salary: r.employee.baseSalary,
    quota: r.employee.quota ?? null,
    bonus_total: bonusTotal,
    ...Object.fromEntries(Object.entries(r.employee.bonuses).map(([label, amt]) => [scopeKey(label), amt])),
  };
  for (const [slot, p] of Object.entries(r.plans)) {
    // A person's own quota beats the plan's default, so one plan serves many quotas.
    const quota = r.employee.quota ?? p.params.quota;
    out[slot] = { ...p.params, ...(quota != null ? { quota } : {}), name: p.planName, tiers: p.tiers };
    if (p.structure?.components.length) {
      // Weighted components: plan.target_incentive, plan.components (for
      // COMPONENT()), and per component plan.<key>_quota / _rate / _target.
      const s = resolveStructure(p.structure);
      out[slot].target_incentive = s.targetIncentive;
      out[slot].components = s.components;
      for (const c of s.components) {
        if (!c.key) continue;
        out[slot][`${c.key}_quota`] = c.quota;
        out[slot][`${c.key}_rate`] = c.rate;
        out[slot][`${c.key}_target`] = c.targetIncentive;
      }
    }
  }
  return out;
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

export interface AssignmentRecord {
  slot: string;
  planName: string;
  params: PlanParams;
  tiers?: PlanTiers;
  structure?: PlanStructure;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  /** Where it came from; an employee's own assignment beats one inherited from their type. */
  source?: 'employee' | 'type';
}

export interface EmployeeRecord extends EmployeeInfo {
  assignments: AssignmentRecord[];
}

/**
 * Build a lookup from employees and their plan assignments (own + inherited
 * from their type). Names match case-insensitively after trimming. Per slot:
 * the employee's own live assignment wins over the type's; among several,
 * the one with the latest start wins.
 */
export function makePlanLookup(employees: EmployeeRecord[], asOf: string): PlanLookup {
  const dated = makeDatedPlanLookup(employees);
  return (rep) => dated(rep, asOf);
}

/** Same lookup, but the "as of" date is chosen per call (e.g. each deal's close date). */
export type DatedPlanLookup = (repName: string, asOf: string) => ResolvedRep | null;

export function makeDatedPlanLookup(employees: EmployeeRecord[]): DatedPlanLookup {
  const byName = new Map<string, EmployeeRecord>();
  for (const e of employees) byName.set(e.name.trim().toLowerCase(), e);
  const rank = (a: AssignmentRecord) => (a.source === 'type' ? 1 : 0);
  return (rep, asOf) => {
    const e = byName.get(rep.trim().toLowerCase());
    if (!e) return null;
    const plans: Record<string, ResolvedPlan> = {};
    const live = e.assignments.filter((a) => (!a.effectiveFrom || a.effectiveFrom <= asOf) && (!a.effectiveTo || a.effectiveTo >= asOf));
    live.sort((a, b) => rank(a) - rank(b) || (b.effectiveFrom ?? '').localeCompare(a.effectiveFrom ?? ''));
    for (const a of live) {
      const slot = scopeKey(a.slot) || DEFAULT_SLOT;
      if (!(slot in plans)) plans[slot] = { planName: a.planName, params: a.params, tiers: a.tiers, structure: a.structure };
    }
    return { employee: { name: e.name, status: e.status, type: e.type, baseSalary: e.baseSalary, quota: e.quota, bonuses: e.bonuses }, plans };
  };
}
