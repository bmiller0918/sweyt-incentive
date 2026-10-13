import { describe, expect, it } from 'vitest';
import { makeDatedPlanLookup, repScope, type EmployeeRecord } from './calc.js';
import { computeCommissionLines, type DealInput } from './lines.js';
import { emptyQuotas, planQuotasSchema, primaryTiers, quotasFromLegacy, type PlanQuotas } from './quotas.js';

const rep = (quotas: PlanQuotas, quota: number | null = null): EmployeeRecord => ({
  name: 'Sam Rep',
  baseSalary: null,
  quota,
  bonuses: {},
  assignments: [{ slot: 'plan', planName: 'Foodservice 2026', params: {}, quotas, effectiveFrom: null, effectiveTo: null }],
});

const deal = (rowIndex: number, amount: number | null, margin?: number | null): DealInput => ({
  rowIndex,
  dealKey: `D-${rowIndex}`,
  date: `2026-01-${String(rowIndex).padStart(2, '0')}`,
  amount,
  payees: [{ role: 'Rep', name: 'Sam Rep' }],
  ...(margin !== undefined ? { margin } : {}),
});

const withSection = (patch: Partial<PlanQuotas>): PlanQuotas => ({ ...emptyQuotas(), ...patch });

describe('quota sections', () => {
  it('parses an empty object into four sections that do not apply', () => {
    const q = planQuotasSchema.parse({});
    expect(Object.values(q).every((s) => !s.applies && s.rows.length === 0)).toBe(true);
  });

  it('pays a dollars quota with marginal tiers', () => {
    const q = withSection({ dollars: { applies: true, target: null, mode: 'marginal', rows: [{ from: 0, rate: 0.05 }, { from: 100_000, rate: 0.1 }] } });
    const res = computeCommissionLines([deal(1, 80_000), deal(2, 40_000)], makeDatedPlanLookup([rep(q)]));
    expect(res.lines.map((l) => [l.component, l.amount, l.rate, l.payout])).toEqual([
      ['Dollars quota', 80_000, 0.05, 4_000],
      ['Dollars quota', 20_000, 0.05, 1_000],
      ['Dollars quota', 20_000, 0.1, 2_000],
    ]);
  });

  it('pays a count quota per unit, one unit per deal', () => {
    const q = withSection({ count: { applies: true, target: 3, mode: 'marginal', rows: [{ from: 0, rate: 100 }, { from: 2, rate: 250 }] } });
    const res = computeCommissionLines([deal(1, 5_000), deal(2, 5_000), deal(3, 5_000)], makeDatedPlanLookup([rep(q)]));
    expect(res.lines.map((l) => l.payout)).toEqual([100, 100, 250]);
    expect(res.lines[2]).toMatchObject({ component: 'Count quota', amount: 1, cumulativeAfter: 3 });
  });

  it('scales percent-of-quota thresholds by the employee quota over the section quota', () => {
    const q = withSection({ percentOfQuota: { applies: true, target: 1_000_000, mode: 'marginal', rows: [{ from: 0, rate: 0.05 }, { from: 1, rate: 0.1 }] } });
    const own = computeCommissionLines([deal(1, 600_000)], makeDatedPlanLookup([rep(q, 500_000)]));
    expect(own.lines.map((l) => [l.amount, l.rate])).toEqual([
      [500_000, 0.05],
      [100_000, 0.1],
    ]);
    const plan = computeCommissionLines([deal(1, 600_000)], makeDatedPlanLookup([rep(q)]));
    expect(plan.lines).toHaveLength(1);
    expect(plan.lines[0]).toMatchObject({ rate: 0.05, payout: 30_000 });
  });

  it('flags a percent-of-quota section with no quota anywhere', () => {
    const q = withSection({ percentOfQuota: { applies: true, target: null, mode: 'marginal', rows: [{ from: 0, rate: 0.05 }] } });
    const res = computeCommissionLines([deal(1, 10_000)], makeDatedPlanLookup([rep(q)]));
    expect(res.lines[0]).toMatchObject({ method: 'none', payout: null, component: 'Percent of quota' });
  });

  it("pays percent of margin at the rate the deal's margin % reaches", () => {
    // Below 10% GM pays nothing; 10% pays 20% of GP; 20%+ pays 30% of GP.
    const q = withSection({ percentOfMargin: { applies: true, target: null, mode: 'whole', rows: [{ from: 0.1, rate: 0.2 }, { from: 0.2, rate: 0.3 }] } });
    const res = computeCommissionLines([deal(1, 10_000, 500), deal(2, 10_000, 1_500), deal(3, 10_000, 2_500)], makeDatedPlanLookup([rep(q)]));
    expect(res.lines.map((l) => [l.method, l.amount, l.rate, l.payout])).toEqual([
      ['margin', 500, 0, 0],
      ['margin', 1_500, 0.2, 300],
      ['margin', 2_500, 0.3, 750],
    ]);
    expect(res.lines[0].note).toMatch(/below the first tier/);
  });

  it('warns when a margin plan runs without a margin column', () => {
    const q = withSection({ percentOfMargin: { applies: true, target: null, mode: 'whole', rows: [{ from: 0, rate: 0.25 }] } });
    const res = computeCommissionLines([deal(1, 10_000)], makeDatedPlanLookup([rep(q)]));
    expect(res.lines).toHaveLength(0);
    expect(res.warnings.join(' ')).toMatch(/maps no margin column/);
  });

  it('pays one line per section that applies', () => {
    const q = withSection({
      count: { applies: true, target: null, mode: 'marginal', rows: [{ from: 0, rate: 50 }] },
      dollars: { applies: true, target: null, mode: 'marginal', rows: [{ from: 0, rate: 0.02 }] },
      percentOfMargin: { applies: true, target: null, mode: 'whole', rows: [{ from: 0, rate: 0.25 }] },
    });
    const res = computeCommissionLines([deal(1, 10_000, 2_000)], makeDatedPlanLookup([rep(q)]));
    expect(res.lines.map((l) => [l.component, l.payout])).toEqual([
      ['Count quota', 50],
      ['Dollars quota', 200],
      ['Percent of margin', 500],
    ]);
    expect(res.totalPayout).toBe(750);
    expect(res.totals[0].deals).toBe(1);
  });

  it('pays nothing when no section applies, rather than falling back to a hidden rate', () => {
    const res = computeCommissionLines([deal(1, 10_000)], makeDatedPlanLookup([{ ...rep(emptyQuotas()), assignments: [{ ...rep(emptyQuotas()).assignments[0], params: { rate: 0.1 } }] }]));
    expect(res.lines[0]).toMatchObject({ method: 'none', note: 'No quota section applies on this plan' });
  });
});

describe('quotasFromLegacy', () => {
  it('moves a percent-of-quota tier table and its quota into that section', () => {
    const q = quotasFromLegacy({ params: { quota: 500_000 }, tiers: { mode: 'whole', basis: 'percent_of_quota', scaleParam: 'quota', rows: [{ from: 0, rate: 0.05 }] } });
    expect(q.percentOfQuota).toEqual({ applies: true, target: 500_000, mode: 'whole', rows: [{ from: 0, rate: 0.05 }] });
    expect(q.dollars.applies).toBe(false);
  });

  it('maps dollars and count tier tables, and a flat rate to a one-tier dollars quota', () => {
    expect(quotasFromLegacy({ tiers: { mode: 'marginal', basis: 'amount', scaleParam: null, rows: [{ from: 0, rate: 0.1 }] } }).dollars.applies).toBe(true);
    expect(quotasFromLegacy({ tiers: { mode: 'marginal', basis: 'count', scaleParam: null, rows: [{ from: 0, rate: 5 }] } }).count.applies).toBe(true);
    expect(quotasFromLegacy({ params: { rate: 0.08 } }).dollars).toMatchObject({ applies: true, rows: [{ from: 0, rate: 0.08 }] });
    expect(Object.values(quotasFromLegacy({})).some((s) => s.applies)).toBe(false);
  });
});

describe('formula scope for sectioned plans', () => {
  it('exposes the percent-of-quota quota and tiers to Calculate', () => {
    const q = withSection({ percentOfQuota: { applies: true, target: 750_000, mode: 'marginal', rows: [{ from: 0, rate: 0.05 }] } });
    const scope = repScope(makeDatedPlanLookup([rep(q)])('Sam Rep', '2026-01-01'));
    expect(scope.plan.quota).toBe(750_000);
    expect(scope.plan.tiers).toEqual(primaryTiers(q));
  });
});
