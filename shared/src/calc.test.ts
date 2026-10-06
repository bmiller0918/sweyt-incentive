import { describe, expect, it } from 'vitest';
import { applyCalc, asOfFromCriteria, makePlanLookup } from './calc.js';
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

const lookup = makePlanLookup(
  [
    { repName: 'Alice', planName: 'Enterprise', params: { rate: 0.12, quota: 40000, accel: 0.2 }, effectiveFrom: '2025-01-01', effectiveTo: null },
    { repName: 'Alice', planName: 'Old plan', params: { rate: 0.05 }, effectiveFrom: '2024-01-01', effectiveTo: '2024-12-31' },
    { repName: 'Bob', planName: 'SMB', params: { rate: 0.1, quota: 30000, accel: 0.15 }, effectiveFrom: null, effectiveTo: null },
  ],
  '2025-11-15',
);

describe('makePlanLookup', () => {
  it('matches case-insensitively and by effective date', () => {
    expect(lookup('alice')?.planName).toBe('Enterprise');
    expect(lookup(' BOB ')?.planName).toBe('SMB');
    expect(lookup('Carol')).toBeNull();
    const past = makePlanLookup(
      [{ repName: 'Alice', planName: 'Old plan', params: { rate: 0.05 }, effectiveFrom: '2024-01-01', effectiveTo: '2024-12-31' }],
      '2024-06-01',
    );
    expect(past('Alice')?.planName).toBe('Old plan');
    expect(past('Alice')?.params.rate).toBe(0.05);
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
  it('adds a Plan column and formula outputs using plan params', () => {
    const r = applyCalc(
      summary,
      {
        repField: 'Rep',
        items: [
          { id: 'a', label: 'Commission', formula: 'MIN([Won], plan.quota) * plan.rate + MAX(0, [Won] - plan.quota) * plan.accel' },
          { id: 'b', label: 'Over quota', formula: '[Won] > plan.quota' },
          { id: 'c', label: 'Doubled', formula: '[Commission] * 2' },
        ],
      },
      lookup,
    );
    expect(r.columns.map((c) => c.name)).toEqual(['Rep', 'Won', 'Plan', 'Commission', 'Over quota', 'Doubled']);
    expect(r.columns.map((c) => c.type)).toEqual(['text', 'currency', 'text', 'decimal', 'text', 'decimal']);
    expect(r.raw[0]).toEqual({ Rep: 'Alice', Won: '50000', Plan: 'Enterprise', Commission: '6800', 'Over quota': 'true', Doubled: '13600' });
    expect(r.raw[1].Commission).toBe('2000');
    // Carol has no plan: plan.* is null, arithmetic yields blank.
    expect(r.raw[2]).toEqual({ Rep: 'Carol', Won: '1000', Plan: '', Commission: '', 'Over quota': '', Doubled: '' });
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
