import { describe, expect, it } from 'vitest';
import { componentAttainment, componentPayout, componentRate, findComponent, resolveStructure, type PlanComponent, type PlanStructure } from './components.js';
import { evaluateFormula } from './formula.js';

const comp = (name: string, weight: PlanComponent['weight'], quota: number | null, rows: { from: number; rate: number }[] = [], mode: 'marginal' | 'whole' = 'marginal'): PlanComponent => ({
  id: name.toLowerCase(),
  name,
  weight,
  quota,
  tiers: { mode, rows },
});

// $100K variable pay: 60% New ARR on a $1.2M quota, 40% Renewals on $2M.
const plan: PlanStructure = {
  targetIncentive: 100_000,
  components: [
    comp('New ARR', { kind: 'percent', value: 0.6 }, 1_200_000, [
      { from: 0, rate: 1 },
      { from: 1, rate: 1.5 },
    ]),
    comp('Renewals', { kind: 'percent', value: 0.4 }, 2_000_000),
  ],
};

describe('resolveStructure', () => {
  it('turns percent weights into dollars and on-target rates', () => {
    const r = resolveStructure(plan);
    expect(r.issues).toEqual([]);
    expect(r.weightTotal).toBeCloseTo(1);
    const [arr, ren] = r.components;
    expect(arr).toMatchObject({ key: 'new_arr', weight: 0.6, targetIncentive: 60_000, rate: 0.05 });
    expect(ren).toMatchObject({ key: 'renewals', weight: 0.4, targetIncentive: 40_000, rate: 0.02, tiers: null });
    expect(arr.tiers).toMatchObject({ mode: 'marginal', basis: 'percent_of_quota', scaleParam: 'quota' });
    expect(arr.tiers!.rows.map((r) => r.from)).toEqual([0, 1]);
    expect(arr.tiers!.rows[0].rate).toBeCloseTo(0.05);
    expect(arr.tiers!.rows[1].rate).toBeCloseTo(0.075);
  });

  it('amount weights are dollars; their share comes from the target incentive', () => {
    const r = resolveStructure({ targetIncentive: 100_000, components: [comp('A', { kind: 'amount', value: 25_000 }, 500_000), comp('B', { kind: 'percent', value: 0.75 }, 1_000_000)] });
    expect(r.issues).toEqual([]);
    expect(r.components[0]).toMatchObject({ weight: 0.25, targetIncentive: 25_000, rate: 0.05 });
  });

  it('without a plan target incentive, all-amount components imply it', () => {
    const r = resolveStructure({ targetIncentive: null, components: [comp('A', { kind: 'amount', value: 30_000 }, 300_000), comp('B', { kind: 'amount', value: 70_000 }, 700_000)] });
    expect(r.targetIncentive).toBe(100_000);
    expect(r.components.map((c) => c.weight)).toEqual([0.3, 0.7]);
    expect(r.issues).toEqual([]);
  });

  it('quota-weighted components split the remainder in proportion to their quotas', () => {
    const r = resolveStructure({
      targetIncentive: 100_000,
      components: [comp('Fixed', { kind: 'percent', value: 0.5 }, 500_000), comp('X', { kind: 'quota' }, 300_000), comp('Y', { kind: 'quota' }, 200_000)],
    });
    expect(r.issues).toEqual([]);
    expect(r.components[1]).toMatchObject({ weight: 0.3, targetIncentive: 30_000, rate: 0.1 });
    expect(r.components[2]).toMatchObject({ weight: 0.2, targetIncentive: 20_000, rate: 0.1 });
    expect(r.weightTotal).toBeCloseTo(1);
  });

  it('flags weights that do not add up and missing quotas', () => {
    const r = resolveStructure({ targetIncentive: 100_000, components: [comp('A', { kind: 'percent', value: 0.5 }, null), comp('B', { kind: 'percent', value: 0.3 }, 100)] });
    expect(r.issues.some((i) => i.includes('80%'))).toBe(true);
    expect(r.components[0].issues[0]).toMatch(/quota/);
    expect(r.components[0].rate).toBeNull();
    expect(resolveStructure({ targetIncentive: 100_000, components: [comp('A', { kind: 'percent', value: 0.7 }, 1), comp('B', { kind: 'amount', value: 50_000 }, 1)] }).issues[0]).toMatch(/more than/);
  });

  it('needs a target incentive for percent and quota weights', () => {
    const r = resolveStructure({ targetIncentive: null, components: [comp('A', { kind: 'percent', value: 1 }, 100)] });
    expect(r.components[0].targetIncentive).toBeNull();
    expect(r.issues[0]).toMatch(/target incentive/);
  });

  it('finds components by name or key', () => {
    const r = resolveStructure(plan);
    expect(findComponent(r.components, 'New ARR')?.key).toBe('new_arr');
    expect(findComponent(r.components, 'new_arr')?.name).toBe('New ARR');
    expect(findComponent(r.components, 'nope')).toBeNull();
  });
});

describe('componentPayout', () => {
  const [arr, ren] = resolveStructure(plan).components;
  it('pays the on-target rate up to quota and the accelerated rate above it', () => {
    expect(componentPayout(600_000, arr)).toBeCloseTo(30_000);
    expect(componentPayout(1_200_000, arr)).toBeCloseTo(60_000);
    // $200K over quota at 150% of 5%
    expect(componentPayout(1_400_000, arr)).toBeCloseTo(60_000 + 200_000 * 0.075);
    expect(componentRate(1_400_000, arr)).toBeCloseTo(0.075);
    expect(componentAttainment(600_000, arr)).toBe(0.5);
  });
  it('a component without tiers is flat at the on-target rate', () => {
    expect(componentPayout(3_000_000, ren)).toBeCloseTo(60_000);
    expect(componentRate(1, ren)).toBe(0.02);
  });
  it('whole mode re-rates everything at the tier reached', () => {
    const r = resolveStructure({ targetIncentive: 50_000, components: [comp('A', { kind: 'percent', value: 1 }, 500_000, [{ from: 0, rate: 1 }, { from: 1, rate: 2 }], 'whole')] });
    expect(componentPayout(600_000, r.components[0])).toBeCloseTo(600_000 * 0.2);
  });
  it('is null when the rate cannot be determined', () => {
    const r = resolveStructure({ targetIncentive: null, components: [comp('A', { kind: 'percent', value: 1 }, 100)] });
    expect(componentPayout(50, r.components[0])).toBeNull();
  });
});

describe('COMPONENT() in formulas', () => {
  const scope = { Won: 1_400_000, plan: { components: resolveStructure(plan).components, target_incentive: 100_000 } };
  it('pays by component name', () => {
    expect(evaluateFormula('COMPONENT([Won], "New ARR")', scope)).toBeCloseTo(75_000);
    expect(evaluateFormula('COMPONENT_RATE([Won], "new_arr")', scope)).toBeCloseTo(0.075);
    expect(evaluateFormula('COMPONENT([Won], "Renewals")', scope)).toBeCloseTo(28_000);
  });
  it('reads another slot and is null for unknown components', () => {
    expect(evaluateFormula('COMPONENT([Won], "New ARR", "spiff")', { ...scope, spiff: scope.plan })).toBeCloseTo(75_000);
    expect(evaluateFormula('COMPONENT([Won], "Services")', scope)).toBeNull();
    expect(evaluateFormula('COMPONENT([Won], "New ARR")', { Won: 1, plan: {} })).toBeNull();
  });
});
