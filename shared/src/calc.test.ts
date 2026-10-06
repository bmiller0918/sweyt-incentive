import { describe, expect, it } from 'vitest';
import { applyCalc, asOfFromCriteria, makePlanLookup, scopeKey, type EmployeeRecord } from './calc.js';
import type { SummaryResult } from './summary.js';

const summary: SummaryResult = {
  columns: [
    { name: 'Rep', index: 0, type: 'text', inferredType: 'text' },
    { name: 'Won', index: 1, type: 'currency', inferredType: 'currency' },
  ],
  raw: [
    { Rep: 'Alice', Won: '50000' },
    { Rep: 'bob', Won: '20000' },
    { Rep: 'Carol', Won: '1000' },
  ],
  typed: [
    { Rep: 'Alice', Won: 50000 },
    { Rep: 'bob', Won: 20000 },
    { Rep: 'Carol', Won: 1000 },
  ],
  groupCount: 3,
};

const employees: EmployeeRecord[] = [
  {
    name: 'Alice',
    baseSalary: 90000,
    bonuses: { 'Q4 SPIFF bonus': 2500 },
    assignments: [
      { slot: 'plan', planName: 'Enterprise', params: { rate: 0.12, quota: 40000, accel: 0.2 }, effectiveFrom: '2025-01-01', effectiveTo: null },
      { slot: 'plan', planName: 'Old plan', params: { rate: 0.05 }, effectiveFrom: '2024-01-01', effectiveTo: '2024-12-31' },
      {
        slot: 'spiff',
        planName: 'Q4 SPIFF',
        params: { rate: 0.02 },
        tiers: { mode: 'whole', basis: 'amount', rows: [{ from: 0, rate: 0.01 }, { from: 40000, rate: 0.03 }] },
        effectiveFrom: '2025-10-01',
        effectiveTo: '2025-12-31',
      },
    ],
  },
  { name: 'Bob', status: 'terminated', baseSalary: null, bonuses: {}, assignments: [{ slot: 'plan', planName: 'SMB', params: { rate: 0.1, quota: 30000, accel: 0.15 }, effectiveFrom: null, effectiveTo: null }] },
  { name: 'Dave', baseSalary: 50000, bonuses: {}, assignments: [] },
];

const lookup = makePlanLookup(employees, '2025-11-15');

describe('makePlanLookup', () => {
  it('matches case-insensitively, by effective date, per slot', () => {
    const alice = lookup('alice')!;
    expect(alice.plans.plan.planName).toBe('Enterprise');
    expect(alice.plans.spiff.planName).toBe('Q4 SPIFF');
    expect(alice.employee.baseSalary).toBe(90000);
    expect(lookup(' BOB ')?.plans.plan.planName).toBe('SMB');
    expect(lookup('Carol')).toBeNull();
    expect(Object.keys(lookup('Dave')!.plans)).toEqual([]);
    const past = makePlanLookup(employees, '2024-06-01');
    expect(past('Alice')?.plans.plan.planName).toBe('Old plan');
    expect(past('Alice')?.plans.spiff).toBeUndefined();
  });
  it('scopeKey normalises bonus labels', () => {
    expect(scopeKey('Q4 SPIFF bonus')).toBe('q4_spiff_bonus');
    expect(scopeKey('  Car allowance! ')).toBe('car_allowance');
  });
});

describe('asOfFromCriteria', () => {
  const today = Date.UTC(2025, 10, 12);
  const root = (children: Parameters<typeof asOfFromCriteria>[0]['root']['children']) => ({ root: { children } });
  it('uses the period end, else today', () => {
    expect(asOfFromCriteria(root([]), {}, today)).toBe('2025-11-12');
    expect(
      asOfFromCriteria(
        root([{ type: 'condition', id: 'period:Close Date', field: 'Close Date', operator: 'relative', values: [{ kind: 'relative', preset: 'last_quarter' }] }]),
        {},
        today,
      ),
    ).toBe('2025-09-30');
    expect(
      asOfFromCriteria(
        root([{ type: 'condition', id: 'period:Close Date', field: 'Close Date', operator: 'between', values: [{ kind: 'literal', value: '2025-01-01' }, { kind: 'literal', value: '2025-06-30' }] }]),
        {},
        today,
      ),
    ).toBe('2025-06-30');
  });
});

describe('applyCalc', () => {
  it('adds a Plan column and formula outputs using plan, slot and employee scopes', () => {
    const r = applyCalc(
      summary,
      {
        repField: 'Rep',
        items: [
          { id: 'a', label: 'Commission', formula: 'MIN([Won], plan.quota) * plan.rate + MAX(0, [Won] - plan.quota) * plan.accel' },
          { id: 'b', label: 'Spiff', formula: 'TIER([Won], "spiff")' },
          { id: 'c', label: 'OTE', formula: 'employee.base_salary + [Commission] + employee.bonus_total' },
          { id: 'd', label: 'Q4 bonus', formula: 'employee.q4_spiff_bonus' },
          { id: 'e', label: 'Payable', formula: 'IF(employee.status = "active", [Commission], 0)' },
        ],
      },
      lookup,
    );
    expect(r.columns.map((c) => c.name)).toEqual(['Rep', 'Won', 'Plan', 'Commission', 'Spiff', 'OTE', 'Q4 bonus', 'Payable']);
    expect(r.raw[0]).toEqual({ Rep: 'Alice', Won: '50000', Plan: 'Enterprise + Q4 SPIFF (spiff)', Commission: '6800', Spiff: '1500', OTE: '99300', 'Q4 bonus': '2500', Payable: '6800' });
    expect(r.raw[1]).toEqual({ Rep: 'bob', Won: '20000', Plan: 'SMB', Commission: '2000', Spiff: '', OTE: '', 'Q4 bonus': '', Payable: '0' });
    // Carol has no employee record: everything blank.
    expect(r.raw[2].Plan).toBe('');
    expect(r.raw[2].Commission).toBe('');
    expect(r.noPlan).toBe(1);
    expect(r.errors).toEqual({});
  });

  it('flat rate without a plan', () => {
    const r = applyCalc(summary, { items: [{ id: 'a', label: 'Comm', formula: '[Won] * 12%' }] }, null);
    expect(r.columns.map((c) => c.name)).toEqual(['Rep', 'Won', 'Comm']);
    expect(r.raw.map((x) => x.Comm)).toEqual(['6000', '2400', '120']);
    expect(r.noPlan).toBe(0);
  });

  it('reports formula errors per item and keeps going', () => {
    const r = applyCalc(summary, { items: [{ id: 'bad', label: 'X', formula: '[Nope] * 2' }, { id: 'ok', label: 'Y', formula: '[Won] + 1' }] }, null);
    expect(r.errors.bad).toMatch(/Unknown field/);
    expect(r.raw[0].X).toBe('');
    expect(r.raw[0].Y).toBe('50001');
  });

  it('de-duplicates output names', () => {
    const r = applyCalc(summary, { items: [{ id: 'a', label: 'Won', formula: '1' }] }, null);
    expect(r.columns.map((c) => c.name)).toEqual(['Rep', 'Won', 'Won (2)']);
  });
});
