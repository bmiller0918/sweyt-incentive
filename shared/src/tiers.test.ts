import { describe, expect, it } from 'vitest';
import { evaluateFormula } from './formula.js';
import { tierPayout, tierRate, type PlanTiers } from './tiers.js';

const marginal: PlanTiers = { mode: 'marginal', basis: 'amount', rows: [{ from: 0, rate: 0.05 }, { from: 50000, rate: 0.1 }, { from: 100000, rate: 0.15 }] };
const whole: PlanTiers = { ...marginal, mode: 'whole' };
const attainment: PlanTiers = { mode: 'marginal', basis: 'percent_of_quota', rows: [{ from: 0, rate: 0.05 }, { from: 0.8, rate: 0.08 }, { from: 1, rate: 0.12 }] };

describe('tiers', () => {
  it('marginal: each slice at its own rate', () => {
    expect(tierPayout(30000, marginal, null)).toBe(1500);
    expect(tierPayout(50000, marginal, null)).toBe(2500);
    expect(tierPayout(120000, marginal, null)).toBe(50000 * 0.05 + 50000 * 0.1 + 20000 * 0.15);
    expect(tierPayout(0, marginal, null)).toBe(0);
  });
  it('whole: highest tier reached re-rates everything', () => {
    expect(tierPayout(30000, whole, null)).toBe(1500);
    expect(tierPayout(50000, whole, null)).toBe(5000);
    expect(tierPayout(120000, whole, null)).toBe(18000);
    expect(tierRate(120000, whole, null)).toBe(0.15);
  });
  it('tiers that start above zero pay nothing below the first threshold', () => {
    const t: PlanTiers = { mode: 'marginal', basis: 'amount', rows: [{ from: 10000, rate: 0.1 }] };
    expect(tierPayout(5000, t, null)).toBe(0);
    expect(tierRate(5000, t, null)).toBe(0);
    expect(tierPayout(15000, t, null)).toBe(500);
  });
  it('percent-of-quota thresholds scale by plan.quota', () => {
    // quota 100k: 0-80k @5%, 80-100k @8%, 100k+ @12%
    expect(tierPayout(90000, attainment, 100000)).toBe(80000 * 0.05 + 10000 * 0.08);
    expect(tierRate(90000, attainment, 100000)).toBe(0.08);
    expect(tierPayout(90000, attainment, null)).toBeNull();
    expect(tierPayout(90000, attainment, 0)).toBeNull();
  });
  it('custom threshold types: counts are absolute; scaleParam picks any plan parameter', () => {
    const calls: PlanTiers = { mode: 'whole', basis: 'count', scaleParam: null, rows: [{ from: 0, rate: 0 }, { from: 100, rate: 5 }, { from: 200, rate: 8 }] };
    // "rate" here is dollars per call once the tier is reached
    expect(tierPayout(150, calls, null)).toBe(750);
    expect(tierRate(250, calls, null)).toBe(8);
    const pctOfTarget: PlanTiers = { mode: 'marginal', basis: 'pct_target', scaleParam: 'target', rows: [{ from: 0, rate: 1 }, { from: 1, rate: 2 }] };
    expect(tierPayout(120, pctOfTarget, 100)).toBe(100 * 1 + 20 * 2);
    expect(evaluateFormula('TIER([Meetings])', { Meetings: 120, plan: { target: 100, tiers: pctOfTarget } })).toBe(140);
  });
  it('unsorted rows are fine', () => {
    const t: PlanTiers = { ...marginal, rows: [...marginal.rows].reverse() };
    expect(tierPayout(120000, t, null)).toBe(tierPayout(120000, marginal, null));
  });
});

describe('TIER() in formulas', () => {
  const scope = { Won: 120000, plan: { rate: 0.1, quota: 100000, tiers: marginal } };
  it('uses the row plan tiers', () => {
    expect(evaluateFormula('TIER([Won])', scope)).toBe(10500);
    expect(evaluateFormula('TIER_RATE([Won])', scope)).toBe(0.15);
    expect(evaluateFormula('ROUND(TIER([Won]) * 1.1, 2)', scope)).toBe(11550);
  });
  it('is null without tiers', () => {
    expect(evaluateFormula('TIER([Won])', { Won: 1, plan: { rate: 0.1 } })).toBeNull();
    expect(evaluateFormula('TIER([Won])', { Won: 1, plan: {} })).toBeNull();
  });
});
