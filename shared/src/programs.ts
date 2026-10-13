// Incentive programs: spiffs, accelerators and bonuses. They sit beside the
// annual comp plan and pay on metrics for a time window:
//
//   spiff        (counts)                  a metric × a rate, e.g. $10 per demo booked
//   accelerator  (time period with a rate) once a person's dollars in the window
//                                          pass a threshold, the dollars above it
//                                          earn an extra rate
//   bonus        (metrics)                 a flat amount when a metric reaches a
//                                          threshold in a period (month, quarter
//                                          or the whole window)
//
// A metric is rows of any import (deals, calls, an uploaded scorecard),
// filtered, credited to the person in a rep column, and counted or summed.
// Pure: a program and its rows in, commission lines out.
import { z } from 'zod';
import { formatDateMs } from './coerce.js';
import { conditionSchema, type Condition, type Criteria } from './criteria.js';
import { compileCriteria, type EvalContext } from './evaluate.js';
import { roundCents, type CommissionLine } from './lines.js';
import type { RawRow, TypedRow } from './types.js';

export const PROGRAM_KINDS = ['spiff', 'accelerator', 'bonus'] as const;
export type ProgramKind = (typeof PROGRAM_KINDS)[number];

export const PROGRAM_KIND_LABELS: Record<ProgramKind, { label: string; plural: string; short: string; hint: string }> = {
  spiff: { label: 'Spiff', plural: 'Spiffs', short: 'Counts', hint: 'Pay a rate on a count or total, e.g. $10 per demo booked this month.' },
  accelerator: { label: 'Accelerator', plural: 'Accelerators', short: 'Time period with a rate', hint: 'During a window, once someone passes a dollar threshold, the dollars above it earn an extra rate.' },
  bonus: { label: 'Bonus', plural: 'Bonuses', short: 'Metrics', hint: 'Pay a flat amount when a metric reaches a threshold in a month, quarter or the whole window.' },
};

export const METRIC_AGGS = ['count', 'sum', 'average', 'max'] as const;
export type MetricAgg = (typeof METRIC_AGGS)[number];

export const programDefinitionSchema = z.object({
  /** Column holding the person credited. */
  repField: z.string().default(''),
  /** Date column that places a row in the window and period; none = every row counts. */
  dateField: z.string().nullable().default(null),
  /** Deal identifier column, shown on accelerator lines. */
  dealKeyField: z.string().nullable().default(null),
  /** Which rows count, e.g. "Activity is Demo". All must match. */
  filters: z.array(conditionSchema).default([]),
  /** count = rows; sum / average / max of `field`. Accelerators always sum. */
  measure: z.object({ agg: z.enum(METRIC_AGGS).default('count'), field: z.string().nullable().default(null) }).default({}),
  spiff: z
    .object({
      /** per_unit: dollars per unit of the metric; percent: a fraction of it (for dollar metrics). */
      rateKind: z.enum(['per_unit', 'percent']).default('per_unit'),
      rate: z.number().default(0),
      /** Most one person can earn per period; null = no cap. */
      cap: z.number().nullable().default(null),
      /** Count over the whole time period or each month / quarter; with no end date, "whole" counts by month. */
      period: z.enum(['window', 'month', 'quarter']).default('window'),
    })
    .default({}),
  accelerator: z
    .object({
      /** Dollars in the window before the uplift starts. */
      threshold: z.number().default(0),
      /** Extra rate on the dollars above the threshold (0.03 = +3%). */
      uplift: z.number().default(0),
    })
    .default({}),
  bonus: z
    .object({
      period: z.enum(['window', 'month', 'quarter']).default('window'),
      /** Highest tier reached pays its amount, once per period. */
      tiers: z.array(z.object({ from: z.number(), amount: z.number() })).default([]),
    })
    .default({}),
});
export type ProgramDefinition = z.infer<typeof programDefinitionSchema>;

export interface ProgramInput {
  name: string;
  kind: ProgramKind;
  /** YYYY-MM-DD bounds; null = open. */
  effectiveFrom: string | null;
  effectiveTo: string | null;
  /** Employee type names the program is for; empty = everyone. */
  employeeTypes: string[];
  definition: ProgramDefinition;
}

export interface ProgramData {
  raw: RawRow[];
  typed: TypedRow[];
  ctx: EvalContext;
}

export interface ProgramOptions {
  /**
   * A commission run's window. Metrics always accrue over the program's own
   * time period (so a $500K accelerator threshold counts October's deals in
   * November's run); the run pays the lines dated inside its window: a
   * spiff or bonus on its period's last day, an accelerator on the deal's
   * date. Lines with no date pay only in runs with no window.
   */
  from?: string | null;
  to?: string | null;
  /** The person as Employees knows them, with their type; null when not an employee. */
  employee: (name: string) => { name: string; type: string | null } | null;
}

export interface ProgramResult {
  lines: CommissionLine[];
  warnings: string[];
}

export function emptyDefinition(): ProgramDefinition {
  return programDefinitionSchema.parse({});
}

/** "$10 per demo" style: what one unit of the metric is called. */
export function metricLabel(d: ProgramDefinition): string {
  if (d.measure.agg === 'count') return 'rows';
  return `${d.measure.agg} of ${d.measure.field ?? '?'}`;
}


function periodOf(date: string | null, period: 'window' | 'month' | 'quarter'): string {
  if (period === 'window' || !date) return 'window';
  if (period === 'month') return date.slice(0, 7);
  return `${date.slice(0, 4)}-Q${Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1}`;
}

/** Rows grouped by period key, in period order. */
function groupByPeriod<T extends { date: string | null }>(hs: T[], period: 'window' | 'month' | 'quarter'): [string, T[]][] {
  const m = new Map<string, T[]>();
  for (const h of hs) {
    const k = periodOf(h.date, period);
    m.set(k, [...(m.get(k) ?? []), h]);
  }
  return [...m].sort(([a], [b]) => a.localeCompare(b));
}

/** Last day of a period key ('2026-03', '2026-Q1'), for the line's date; null for the window. */
function periodEnd(key: string, windowTo: string | null): string | null {
  if (key === 'window') return windowTo;
  const [y, rest] = key.split('-');
  const month = rest.startsWith('Q') ? Number(rest.slice(1)) * 3 : Number(rest);
  const last = new Date(Date.UTC(Number(y), month, 0)).getUTCDate();
  return `${y}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}

/**
 * Lines a program pays over its rows. Rows outside the window, rows that
 * fail a filter and people outside the program's employee types are left
 * out; people who are not employees are skipped with a warning.
 */
export function computeProgramLines(program: ProgramInput, data: ProgramData, opts: ProgramOptions): ProgramResult {
  const d = program.definition;
  const warnings = new Set<string>();
  const lines: CommissionLine[] = [];
  const from = program.effectiveFrom;
  const to = program.effectiveTo;
  if (!d.repField || !(d.repField in data.ctx.types)) return { lines, warnings: [`${program.name}: pick the column that names the person credited.`] };
  for (const f of [d.dateField, d.dealKeyField, d.measure.agg === 'count' && program.kind !== 'accelerator' ? null : d.measure.field]) {
    if (f && !(f in data.ctx.types)) return { lines, warnings: [`${program.name}: column "${f}" is not in this import.`] };
  }
  const valueField = program.kind === 'accelerator' || d.measure.agg !== 'count' ? d.measure.field : null;
  if ((program.kind === 'accelerator' || d.measure.agg !== 'count') && !valueField) return { lines, warnings: [`${program.name}: pick the column to ${program.kind === 'accelerator' ? 'sum' : d.measure.agg}.`] };

  const filters = (d.filters as Condition[]).filter((c) => c.enabled !== false && c.field);
  let matchers: ((row: TypedRow) => boolean)[];
  try {
    matchers = filters.map((c, i) => compileCriteria({ version: 1, root: { type: 'group', id: `program:f${i}`, conjunction: 'and', children: [c] } } as Criteria, data.ctx).matches);
  } catch (e) {
    return { lines, warnings: [`${program.name}: ${(e as Error).message}`] };
  }
  const types = new Set(program.employeeTypes.map((t) => t.trim().toLowerCase()));

  // Rows that count, credited to an eligible employee.
  interface Hit {
    index: number;
    payee: string;
    date: string | null;
    value: number | null;
    dealKey: string | null;
  }
  const hits: Hit[] = [];
  data.typed.forEach((row, i) => {
    let date: string | null = null;
    if (d.dateField) {
      const ms = row[d.dateField];
      date = typeof ms === 'number' ? formatDateMs(ms, 'date') : null;
      if ((from || to) && date === null) return;
      if (from && date !== null && date < from) return;
      if (to && date !== null && date > to) return;
    }
    if (!matchers.every((m) => m(row))) return;
    const name = String(data.raw[i]?.[d.repField] ?? '').trim();
    if (!name) return;
    const emp = opts.employee(name);
    if (!emp) {
      warnings.add(`${name} is not in Employees, so ${program.name} paid them nothing.`);
      return;
    }
    if (types.size && !types.has((emp.type ?? '').trim().toLowerCase())) return;
    const v = valueField ? row[valueField] : null;
    hits.push({
      index: i,
      payee: emp.name,
      date,
      value: typeof v === 'number' ? v : null,
      dealKey: d.dealKeyField ? String(data.raw[i]?.[d.dealKeyField] ?? '').trim() || null : null,
    });
  });

  const base = (payee: string, dealDate: string | null): Pick<CommissionLine, 'rowIndex' | 'dealKey' | 'dealDate' | 'dealAmount' | 'payee' | 'role' | 'planName' | 'component' | 'tierFrom' | 'tierTo' | 'split'> => ({
    rowIndex: -1,
    dealKey: null,
    dealDate,
    dealAmount: null,
    payee,
    role: 'Rep',
    planName: program.name,
    component: PROGRAM_KIND_LABELS[program.kind].label,
    tierFrom: null,
    tierTo: null,
    split: false,
  });

  const byPayee = new Map<string, Hit[]>();
  for (const h of hits) byPayee.set(h.payee, [...(byPayee.get(h.payee) ?? []), h]);
  const aggregate = (hs: Hit[]): number | null => {
    if (d.measure.agg === 'count') return hs.length;
    const vals = hs.map((h) => h.value).filter((v): v is number => v !== null);
    if (!vals.length) return null;
    if (d.measure.agg === 'sum') return vals.reduce((a, b) => a + b, 0);
    if (d.measure.agg === 'average') return vals.reduce((a, b) => a + b, 0) / vals.length;
    return Math.max(...vals);
  };

  if (program.kind === 'spiff') {
    // With no end date there is no "whole period" to wait for, so count by month.
    const period = d.spiff.period === 'window' && !to && d.dateField ? 'month' : d.spiff.period;
    for (const [payee, hs] of byPayee) {
      for (const [k, phs] of groupByPeriod(hs, period)) {
        const metric = aggregate(phs);
        if (metric === null || metric === 0) continue;
        let payout = roundCents(metric * d.spiff.rate);
        let note: string | null = null;
        if (d.spiff.cap !== null && payout > d.spiff.cap) {
          note = `Capped at ${d.spiff.cap}`;
          payout = d.spiff.cap;
        }
        lines.push({ ...base(payee, periodEnd(k, to)), dealKey: k === 'window' ? null : k, method: 'spiff', amount: metric, rate: d.spiff.rate, payout, cumulativeBefore: 0, cumulativeAfter: metric, note });
      }
    }
  } else if (program.kind === 'accelerator') {
    const { threshold, uplift } = d.accelerator;
    for (const [payee, hs] of byPayee) {
      const ordered = [...hs].sort((a, b) => (a.date ?? '￿').localeCompare(b.date ?? '￿') || a.index - b.index);
      let cum = 0;
      for (const h of ordered) {
        if (h.value === null) continue;
        const before = cum;
        cum += h.value;
        const above = Math.max(cum, threshold) - Math.max(before, threshold);
        if (above === 0) continue;
        lines.push({ ...base(payee, h.date), dealKey: h.dealKey, dealAmount: h.value, method: 'accelerator', tierFrom: threshold, amount: above, rate: uplift, payout: roundCents(above * uplift), cumulativeBefore: before, cumulativeAfter: cum, split: above !== h.value, note: null });
      }
    }
  } else {
    const tiers = [...d.bonus.tiers].sort((a, b) => a.from - b.from);
    if (!tiers.length) return { lines, warnings: [`${program.name}: add at least one bonus tier.`] };
    for (const [payee, hs] of byPayee) {
      for (const [k, phs] of groupByPeriod(hs, d.bonus.period)) {
        const metric = aggregate(phs);
        if (metric === null) continue;
        const i = tiers.reduce((at, t, j) => (metric >= t.from ? j : at), -1);
        if (i < 0) continue;
        lines.push({
          ...base(payee, periodEnd(k, to)),
          dealKey: k === 'window' ? null : k,
          method: 'bonus',
          tierFrom: tiers[i].from,
          tierTo: tiers[i + 1]?.from ?? null,
          amount: metric,
          rate: null,
          payout: roundCents(tiers[i].amount),
          cumulativeBefore: 0,
          cumulativeAfter: metric,
          note: null,
        });
      }
    }
  }
  // A run pays the lines dated inside its window.
  if (opts.from || opts.to) {
    const inRun = lines.filter((l) => l.dealDate !== null && (!opts.from || l.dealDate >= opts.from) && (!opts.to || l.dealDate <= opts.to));
    if (lines.some((l) => l.dealDate === null)) warnings.add(`${program.name} has no date to place its pay in a run, so it pays only in runs with no date range.`);
    return { lines: inRun, warnings: [...warnings] };
  }
  return { lines, warnings: [...warnings] };
}
