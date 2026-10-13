import { describe, expect, it } from 'vitest';
import { makeDatedPlanLookup, type EmployeeRecord } from './calc.js';
import { computeCommissionLines, roundCents, type DealInput } from './lines.js';

const accelerated = (quota: number | null = 1_000_000): EmployeeRecord => ({
  name: 'Alice Johnson',
  baseSalary: null,
  quota,
  bonuses: {},
  assignments: [
    {
      slot: 'plan',
      planName: 'AE 2026',
      params: { quota: 1_000_000 },
      // 5% to quota, 10% above it.
      tiers: { mode: 'marginal', basis: 'percent_of_quota', scaleParam: 'quota', rows: [{ from: 0, rate: 0.05 }, { from: 1, rate: 0.1 }] },
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-12-31',
    },
  ],
});

const deal = (rowIndex: number, date: string | null, amount: number | null, name = 'Alice Johnson', role = 'Rep'): DealInput => ({
  rowIndex,
  dealKey: `D-${rowIndex}`,
  date,
  amount,
  payees: [{ role, name }],
});

describe('roundCents', () => {
  it('rounds half away from zero and tolerates float noise', () => {
    expect(roundCents(0.285)).toBe(0.29);
    expect(roundCents(-0.285)).toBe(-0.29);
    expect(roundCents(1.005)).toBe(1.01);
    expect(roundCents(12250)).toBe(12250);
  });
});

describe('computeCommissionLines', () => {
  it("splits the deal that crosses quota: Brayden's $900K + $200K example", () => {
    const lookup = makeDatedPlanLookup([accelerated()]);
    const res = computeCommissionLines([deal(1, '2026-02-01', 900_000), deal(2, '2026-03-01', 200_000)], lookup);
    expect(res.lines).toHaveLength(3);
    const [a, b, c] = res.lines;
    expect(a).toMatchObject({ rowIndex: 1, amount: 900_000, rate: 0.05, payout: 45_000, split: false, cumulativeBefore: 0, cumulativeAfter: 900_000 });
    expect(b).toMatchObject({ rowIndex: 2, amount: 100_000, rate: 0.05, payout: 5_000, split: true, tierFrom: 0, tierTo: 1_000_000 });
    expect(c).toMatchObject({ rowIndex: 2, amount: 100_000, rate: 0.1, payout: 10_000, split: true, tierFrom: 1_000_000, tierTo: null });
    expect(res.totalPayout).toBe(60_000);
    expect(res.totals[0]).toMatchObject({ payee: 'Alice Johnson', deals: 2, amount: 1_100_000, payout: 60_000 });
  });

  it('accrues attainment in close-date order regardless of row order', () => {
    const lookup = makeDatedPlanLookup([accelerated()]);
    // Row 1 closed later, so row 2's $950K comes first and row 1 crosses quota.
    const res = computeCommissionLines([deal(1, '2026-06-01', 100_000), deal(2, '2026-01-15', 950_000)], lookup);
    expect(res.lines.map((l) => l.rowIndex)).toEqual([2, 1, 1]);
    expect(res.lines[1]).toMatchObject({ amount: 50_000, rate: 0.05 });
    expect(res.lines[2]).toMatchObject({ amount: 50_000, rate: 0.1 });
  });

  it('pays the whole deal at the rate reached in whole-amount mode', () => {
    const e = accelerated();
    e.assignments[0].tiers!.mode = 'whole';
    const lookup = makeDatedPlanLookup([e]);
    const res = computeCommissionLines([deal(1, '2026-02-01', 900_000), deal(2, '2026-03-01', 200_000)], lookup);
    expect(res.lines).toHaveLength(2);
    expect(res.lines[1]).toMatchObject({ method: 'whole', amount: 200_000, rate: 0.1, payout: 20_000, split: false });
  });

  it('uses a flat plan.rate when the plan has no tiers', () => {
    const e: EmployeeRecord = {
      name: 'Sam SE',
      baseSalary: null,
      quota: null,
      bonuses: {},
      assignments: [{ slot: 'plan', planName: 'SE flat', params: { rate: 0.02 }, effectiveFrom: null, effectiveTo: null }],
    };
    const res = computeCommissionLines([deal(1, '2026-02-01', 12_345.67, 'Sam SE', 'SE')], makeDatedPlanLookup([e]));
    expect(res.lines[0]).toMatchObject({ method: 'flat', role: 'SE', rate: 0.02, payout: 246.91 });
  });

  it('resolves the plan in force on each deal date (mid-year recast)', () => {
    const e = accelerated();
    e.assignments = [
      { slot: 'plan', planName: 'AE 10%', params: { rate: 0.1 }, effectiveFrom: '2026-01-01', effectiveTo: '2026-06-30' },
      { slot: 'plan', planName: 'AE 7.5% (recast)', params: { rate: 0.075 }, effectiveFrom: '2026-07-01', effectiveTo: null },
    ];
    const res = computeCommissionLines([deal(1, '2026-05-01', 100_000), deal(2, '2026-08-01', 100_000)], makeDatedPlanLookup([e]));
    expect(res.lines[0]).toMatchObject({ planName: 'AE 10%', payout: 10_000 });
    expect(res.lines[1]).toMatchObject({ planName: 'AE 7.5% (recast)', payout: 7_500 });
  });

  it('produces one line per payee on a deal with several people', () => {
    const se: EmployeeRecord = { name: 'Sam SE', baseSalary: null, quota: null, bonuses: {}, assignments: [{ slot: 'plan', planName: 'SE flat', params: { rate: 0.01 }, effectiveFrom: null, effectiveTo: null }] };
    const lookup = makeDatedPlanLookup([accelerated(), se]);
    const d: DealInput = { rowIndex: 1, dealKey: 'D-1', date: '2026-02-01', amount: 50_000, payees: [{ role: 'Rep', name: 'Alice Johnson' }, { role: 'SE', name: 'Sam SE' }] };
    const res = computeCommissionLines([d], lookup);
    expect(res.lines.map((l) => [l.payee, l.payout])).toEqual([
      ['Alice Johnson', 2_500],
      ['Sam SE', 500],
    ]);
    expect(res.dealCount).toBe(1);
  });

  it('flags unknown people and missing plans instead of paying zero', () => {
    const lookup = makeDatedPlanLookup([accelerated()]);
    const res = computeCommissionLines([deal(1, '2027-02-01', 1000), deal(2, '2026-02-01', 1000, 'Nobody')], lookup);
    expect(res.lines.find((l) => l.payee === 'Nobody')).toMatchObject({ method: 'none', payout: null, note: 'No employee named "Nobody"' });
    expect(res.lines.find((l) => l.payee === 'Alice Johnson')).toMatchObject({ method: 'none', payout: null, note: 'No comp plan in force on this date' });
    expect(res.warnings.length).toBe(2);
  });

  it('needs a quota when tiers are a % of quota', () => {
    const res = computeCommissionLines([deal(1, '2026-02-01', 1000)], makeDatedPlanLookup([{ ...accelerated(null), assignments: [{ ...accelerated().assignments[0], params: {} }] }]));
    expect(res.lines[0]).toMatchObject({ method: 'none', note: 'Tier thresholds are a % of quota, but no quota is set' });
  });

  it('handles credit memos (negative amounts) by unwinding the bands they fall back through', () => {
    const lookup = makeDatedPlanLookup([accelerated()]);
    const res = computeCommissionLines([deal(1, '2026-02-01', 1_050_000), deal(2, '2026-03-01', -100_000)], lookup);
    const memo = res.lines.filter((l) => l.rowIndex === 2);
    expect(memo).toHaveLength(2);
    expect(memo.find((l) => l.rate === 0.1)).toMatchObject({ amount: -50_000, payout: -5_000 });
    expect(memo.find((l) => l.rate === 0.05)).toMatchObject({ amount: -50_000, payout: -2_500 });
    // $1M at 5% + $50K at 10%, less the memo's $50K at 10% and $50K at 5%.
    expect(res.totalPayout).toBe(50_000 + 5_000 - 5_000 - 2_500);
  });

  it('unwinds a credit memo below zero attainment at the base rate', () => {
    const lookup = makeDatedPlanLookup([accelerated()]);
    const res = computeCommissionLines([deal(1, '2026-01-10', -500, 'alice johnson'), deal(2, '2026-02-01', 1_012_500)], lookup);
    expect(res.lines[0]).toMatchObject({ payee: 'Alice Johnson', amount: -500, rate: 0.05, payout: -25, cumulativeAfter: -500 });
    expect(res.lines.slice(1).map((l) => [l.amount, l.rate, l.payout])).toEqual([
      [1_000_500, 0.05, 50_025],
      [12_000, 0.1, 1_200],
    ]);
    expect(res.totals).toHaveLength(1);
    expect(res.totals[0]).toMatchObject({ payee: 'Alice Johnson', deals: 2, payout: 51_200 });
  });

  it('carries opening attainment in', () => {
    const lookup = makeDatedPlanLookup([accelerated()]);
    const res = computeCommissionLines([deal(1, '2026-02-01', 100_000)], lookup, { openingAttainment: { 'alice johnson': 950_000 } });
    expect(res.lines.map((l) => [l.amount, l.rate])).toEqual([
      [50_000, 0.05],
      [50_000, 0.1],
    ]);
  });
});

describe('computeCommissionLines with weighted components', () => {
  // $100K target incentive: New ARR 60% on $1.2M (5%, 150% above quota), Renewals 40% on $2M (2%, flat).
  const weighted = (): EmployeeRecord => ({
    name: 'Maya Chen',
    baseSalary: null,
    quota: null,
    bonuses: {},
    assignments: [
      {
        slot: 'plan',
        planName: 'AE weighted',
        params: {},
        structure: {
          targetIncentive: 100_000,
          components: [
            { id: 'a', name: 'New ARR', weight: { kind: 'percent', value: 0.6 }, quota: 1_200_000, tiers: { mode: 'marginal', rows: [{ from: 0, rate: 1 }, { from: 1, rate: 1.5 }] } },
            { id: 'b', name: 'Renewals', weight: { kind: 'percent', value: 0.4 }, quota: 2_000_000, tiers: { mode: 'marginal', rows: [] } },
          ],
        },
        effectiveFrom: null,
        effectiveTo: null,
      },
    ],
  });
  const wdeal = (rowIndex: number, date: string, measures: Record<string, number | null>, amount: number | null = null): DealInput => ({
    rowIndex,
    dealKey: `W-${rowIndex}`,
    date,
    amount,
    payees: [{ role: 'Rep', name: 'Maya Chen' }],
    measures,
  });

  it('pays one line per mapped component with its own attainment and splits at the component quota', () => {
    const lookup = makeDatedPlanLookup([weighted()]);
    const res = computeCommissionLines([wdeal(1, '2026-01-20', { new_arr: 900_000, renewals: 500_000 }, 1_400_000), wdeal(2, '2026-02-14', { new_arr: 500_000, renewals: null }, 500_000)], lookup);
    expect(res.warnings).toEqual([]);
    expect(res.lines.map((l) => [l.component, l.amount, l.rate, l.payout])).toEqual([
      ['New ARR', 900_000, 0.05, 45_000],
      ['Renewals', 500_000, 0.02, 10_000],
      ['New ARR', 300_000, 0.05, 15_000],
      ['New ARR', 200_000, 0.075, 15_000],
    ]);
    expect(res.lines[2]).toMatchObject({ split: true, tierFrom: 0, tierTo: 1_200_000, cumulativeBefore: 900_000, cumulativeAfter: 1_400_000 });
    expect(res.lines[1]).toMatchObject({ method: 'flat', cumulativeBefore: 0, cumulativeAfter: 500_000 });
    expect(res.totalPayout).toBe(85_000);
    expect(res.totals[0]).toMatchObject({ payee: 'Maya Chen', deals: 2, amount: 1_900_000, payout: 85_000 });
  });

  it('warns once about unmapped components and prices nothing for them', () => {
    const lookup = makeDatedPlanLookup([weighted()]);
    const res = computeCommissionLines([wdeal(1, '2026-01-20', { new_arr: 100_000 }), wdeal(2, '2026-01-21', { new_arr: 100_000 })], lookup);
    expect(res.lines).toHaveLength(2);
    expect(res.lines.every((l) => l.component === 'New ARR')).toBe(true);
    expect(res.warnings).toEqual(['Component "Renewals" of plan "AE weighted" is not mapped to a column, so nothing was paid for it.']);
  });

  it('flags a component that cannot be priced instead of paying zero', () => {
    const e = weighted();
    e.assignments[0].structure!.components[0].quota = null;
    const res = computeCommissionLines([wdeal(1, '2026-01-20', { new_arr: 100_000, renewals: 0 })], makeDatedPlanLookup([e]));
    expect(res.lines[0]).toMatchObject({ component: 'New ARR', method: 'none', payout: null, note: 'Set a quota to get an on-target rate' });
    expect(res.lines[1]).toMatchObject({ component: 'Renewals', method: 'flat', payout: 0 });
  });

  it('plans without components still pay from the deal amount', () => {
    const lookup = makeDatedPlanLookup([accelerated()]);
    const res = computeCommissionLines([{ ...deal(1, '2026-02-01', 100_000), measures: { new_arr: 5 } }], lookup);
    expect(res.lines[0]).toMatchObject({ component: null, amount: 100_000, payout: 5_000 });
  });
});
