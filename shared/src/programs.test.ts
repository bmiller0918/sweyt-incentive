import { describe, expect, it } from 'vitest';
import { parseDate } from './coerce.js';
import type { Condition } from './criteria.js';
import { payeeTotals } from './lines.js';
import { computeProgramLines, emptyDefinition, type ProgramDefinition, type ProgramInput } from './programs.js';
import type { ColumnType, RawRow, TypedRow } from './types.js';

const types: Record<string, ColumnType> = { Rep: 'text', Activity: 'text', Date: 'date', Amount: 'currency', Deal: 'text', Score: 'decimal' };

/** Rows as [rep, activity, date, amount, deal, score]. */
function data(rows: [string, string, string, number, string, number][]) {
  const raw: RawRow[] = rows.map(([Rep, Activity, Date, Amount, Deal, Score]) => ({ Rep, Activity, Date, Amount: String(Amount), Deal, Score: String(Score) }));
  const typed: TypedRow[] = rows.map(([Rep, Activity, Date, Amount, Deal, Score]) => ({ Rep, Activity, Date: parseDate(Date), Amount, Deal, Score }));
  return { raw, typed, ctx: { types, timezone: 'UTC', fiscalYearStartMonth: 1 } as never };
}

const staff: Record<string, string> = { 'sam rep': 'SDR', 'ana ae': 'AE' };
const employee = (n: string) => (staff[n.toLowerCase()] ? { name: n.replace(/\b\w/g, (c) => c.toUpperCase()), type: staff[n.toLowerCase()] } : null);

const program = (kind: ProgramInput['kind'], def: Partial<ProgramDefinition>, extra: Partial<ProgramInput> = {}): ProgramInput => ({
  name: 'Test program',
  kind,
  effectiveFrom: null,
  effectiveTo: null,
  employeeTypes: [],
  definition: { ...emptyDefinition(), repField: 'Rep', dateField: 'Date', dealKeyField: 'Deal', ...def },
  ...extra,
});

const demo: Condition = { type: 'condition', id: 'c1', field: 'Activity', operator: 'is', values: [{ kind: 'literal', value: 'Demo' }] };

const rows = data([
  ['Sam Rep', 'Demo', '2026-03-02', 0, 'A-1', 80],
  ['Sam Rep', 'Call', '2026-03-03', 0, 'A-2', 90],
  ['Sam Rep', 'Demo', '2026-03-20', 0, 'A-3', 70],
  ['Sam Rep', 'Demo', '2026-04-02', 0, 'A-4', 100],
  ['Ana AE', 'Demo', '2026-03-05', 0, 'A-5', 60],
  ['Ghost', 'Demo', '2026-03-05', 0, 'A-6', 60],
]);

describe('spiffs', () => {
  it('pays $10 per demo booked in the window', () => {
    const res = computeProgramLines(program('spiff', { filters: [demo], spiff: { rateKind: 'per_unit', rate: 10, cap: null, period: 'window' } }, { effectiveFrom: '2026-03-01', effectiveTo: '2026-03-31' }), rows, { employee });
    expect(res.lines.map((l) => [l.payee, l.amount, l.payout, l.method, l.dealDate])).toEqual([
      ['Sam Rep', 2, 20, 'spiff', '2026-03-31'],
      ['Ana AE', 1, 10, 'spiff', '2026-03-31'],
    ]);
    expect(res.warnings.join(' ')).toMatch(/Ghost is not in Employees/);
  });

  it('limits to the employee types and caps the payout', () => {
    const res = computeProgramLines(program('spiff', { filters: [demo], spiff: { rateKind: 'per_unit', rate: 10, cap: 25, period: 'window' } }, { employeeTypes: ['sdr'], effectiveTo: '2026-12-31' }), rows, { employee });
    expect(res.lines).toHaveLength(1);
    expect(res.lines[0]).toMatchObject({ payee: 'Sam Rep', amount: 3, payout: 25, note: 'Capped at 25' });
  });

  it('counts each month when the spiff has no end date, and a run pays the months that end inside it', () => {
    const p = program('spiff', { filters: [demo], spiff: { rateKind: 'per_unit', rate: 10, cap: null, period: 'window' } });
    const all = computeProgramLines(p, rows, { employee });
    expect(all.lines.map((l) => [l.payee, l.dealKey, l.amount])).toEqual([
      ['Sam Rep', '2026-03', 2],
      ['Sam Rep', '2026-04', 1],
      ['Ana AE', '2026-03', 1],
    ]);
    const april = computeProgramLines(p, rows, { employee, from: '2026-04-01', to: '2026-04-30' });
    expect(april.lines.map((l) => [l.payee, l.amount])).toEqual([['Sam Rep', 1]]);
  });
});

describe('accelerators', () => {
  it('pays the uplift only on dollars above the threshold, in date order', () => {
    const deals = data([
      ['Ana AE', 'Deal', '2026-10-20', 300_000, 'D-2', 0],
      ['Ana AE', 'Deal', '2026-10-05', 300_000, 'D-1', 0],
      ['Ana AE', 'Deal', '2026-11-01', 100_000, 'D-3', 0],
    ]);
    const res = computeProgramLines(program('accelerator', { measure: { agg: 'sum', field: 'Amount' }, accelerator: { threshold: 500_000, uplift: 0.03 } }), deals, { employee });
    expect(res.lines.map((l) => [l.dealKey, l.amount, l.payout, l.split])).toEqual([
      ['D-2', 100_000, 3_000, true],
      ['D-3', 100_000, 3_000, false],
    ]);
  });

  it("counts earlier months toward the threshold in a later month's run", () => {
    const deals = data([
      ['Ana AE', 'Deal', '2026-10-05', 450_000, 'D-1', 0],
      ['Ana AE', 'Deal', '2026-11-03', 100_000, 'D-2', 0],
    ]);
    const p = program('accelerator', { measure: { agg: 'sum', field: 'Amount' }, accelerator: { threshold: 500_000, uplift: 0.03 } }, { effectiveFrom: '2026-10-01', effectiveTo: '2026-12-31' });
    const nov = computeProgramLines(p, deals, { employee, from: '2026-11-01', to: '2026-11-30' });
    expect(nov.lines.map((l) => [l.dealKey, l.amount, l.payout])).toEqual([['D-2', 50_000, 1_500]]);
  });
});

describe('bonuses', () => {
  it('pays the highest tier reached once per period', () => {
    const def = { measure: { agg: 'count' as const, field: null }, filters: [demo], bonus: { period: 'month' as const, tiers: [{ from: 2, amount: 500 }, { from: 5, amount: 1500 }] } };
    const res = computeProgramLines(program('bonus', def), rows, { employee });
    expect(res.lines.map((l) => [l.payee, l.dealKey, l.amount, l.payout, l.dealDate])).toEqual([['Sam Rep', '2026-03', 2, 500, '2026-03-31']]);
  });

  it('uses an average of an uploaded score column per quarter', () => {
    const def = { measure: { agg: 'average' as const, field: 'Score' }, bonus: { period: 'quarter' as const, tiers: [{ from: 80, amount: 1000 }] } };
    const res = computeProgramLines(program('bonus', def), rows, { employee });
    // Sam: Q1 average of 80, 90, 70 = 80 pays; Q2 100 pays. Ana: 60 does not.
    expect(res.lines.map((l) => [l.payee, l.dealKey, l.payout])).toEqual([
      ['Sam Rep', '2026-Q1', 1000],
      ['Sam Rep', '2026-Q2', 1000],
    ]);
  });
});

describe('payeeTotals', () => {
  it('adds program pay without counting deals', () => {
    const res = computeProgramLines(program('spiff', { filters: [demo], spiff: { rateKind: 'per_unit', rate: 10, cap: null, period: 'window' } }, { effectiveTo: '2026-12-31' }), rows, { employee });
    const t = payeeTotals(res.lines);
    expect(t[0]).toMatchObject({ payee: 'Sam Rep', deals: 0, payout: 30 });
  });
});
