// Weighted plan components: a plan's variable pay (its target incentive) is
// split across components — New ARR, Renewals, Services… — by weight. Each
// component has its own quota, so its on-target rate is simply
// target incentive ÷ quota, and a tier table of attainment → payout
// percentage scales that rate (100% = on-target, 150% = accelerator).
//
// Pure: a plan structure in, resolved dollars and rates out. The payout math
// reuses the tier engine by compiling each component into a %-of-quota tier
// table whose rates are absolute, so TIER-style semantics (marginal vs
// whole) carry over unchanged.
import { z } from 'zod';
import { tierPayout, tierRate, type PlanTiers } from './tiers.js';

/**
 * How much of the plan's target incentive a component carries.
 * percent: a share of the target incentive (0.6 = 60%).
 * amount:  a fixed dollar amount of target incentive.
 * quota:   whatever is left after the percent and amount components, split
 *          among the quota-weighted components in proportion to their quotas.
 */
export const componentWeightSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('percent'), value: z.number() }),
  z.object({ kind: z.literal('amount'), value: z.number() }),
  z.object({ kind: z.literal('quota') }),
]);
export type ComponentWeight = z.infer<typeof componentWeightSchema>;

export const componentTierSchema = z.object({
  /** Attainment at which the tier starts, as a fraction of the component quota (0.8 = 80%). */
  from: z.number(),
  /** Payout as a fraction of the on-target rate (1 = 100%, 1.5 = an accelerator). */
  rate: z.number(),
});

export const planComponentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  weight: componentWeightSchema,
  /** Quota for this component, in the units of what it measures (usually dollars). */
  quota: z.number().nullable().default(null),
  tiers: z
    .object({
      mode: z.enum(['marginal', 'whole']).default('marginal'),
      rows: z.array(componentTierSchema).default([]),
    })
    .default({ mode: 'marginal', rows: [] }),
});
export type PlanComponent = z.infer<typeof planComponentSchema>;

export const planStructureSchema = z.object({
  /** Variable pay at 100% attainment on every component; null = derive from amount weights. */
  targetIncentive: z.number().nullable().default(null),
  components: z.array(planComponentSchema).default([]),
});
export type PlanStructure = z.infer<typeof planStructureSchema>;

export function emptyStructure(): PlanStructure {
  return { targetIncentive: null, components: [] };
}

/** "New ARR" -> "new_arr", so a component is addressable in formulas. */
export function componentKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export interface ResolvedComponent {
  id: string;
  name: string;
  key: string;
  /** Share of the plan's target incentive, as a fraction; null when it cannot be determined. */
  weight: number | null;
  /** Dollars of target incentive this component carries at 100% attainment. */
  targetIncentive: number | null;
  quota: number | null;
  /** On-target commission rate: targetIncentive ÷ quota. */
  rate: number | null;
  /** The component's tier table with absolute rates, for the tier engine; null when it has no tiers. */
  tiers: PlanTiers | null;
  /** What stops this component from paying, if anything. */
  issues: string[];
}

export interface ResolvedStructure {
  /** The target incentive used: the plan's, else the sum of amount-weighted components. */
  targetIncentive: number | null;
  components: ResolvedComponent[];
  /** Sum of the resolved weights (1 when the plan is whole). */
  weightTotal: number | null;
  /** Plan-level problems (weights not adding up, nothing to split, …). */
  issues: string[];
}

const EPS = 1e-6;
/** Strip float noise from derived rates (0.05 × 1.5 → 0.075, not 0.07500000000000001). */
const clean = (n: number) => Math.round(n * 1e12) / 1e12;

/** Resolve every component's weight, dollars and on-target rate. */
export function resolveStructure(structure: PlanStructure): ResolvedStructure {
  const comps = structure.components;
  const issues: string[] = [];
  const amountTotal = comps.reduce((a, c) => a + (c.weight.kind === 'amount' ? c.weight.value : 0), 0);
  const allAmounts = comps.length > 0 && comps.every((c) => c.weight.kind === 'amount');
  const ti = structure.targetIncentive ?? (allAmounts ? amountTotal : null);

  const percentTotal = comps.reduce((a, c) => a + (c.weight.kind === 'percent' ? c.weight.value : 0), 0);
  const amountShare = ti ? amountTotal / ti : null;
  const fixedShare = percentTotal + (amountShare ?? 0);
  const quotaComps = comps.filter((c) => c.weight.kind === 'quota');
  const quotaSum = quotaComps.reduce((a, c) => a + Math.max(0, c.quota ?? 0), 0);
  const remainder = Math.max(0, 1 - fixedShare);

  const resolved: ResolvedComponent[] = comps.map((c) => {
    const cIssues: string[] = [];
    let weight: number | null = null;
    let target: number | null = null;
    switch (c.weight.kind) {
      case 'percent':
        weight = c.weight.value;
        target = ti === null ? null : ti * weight;
        if (ti === null) cIssues.push('Set the plan target incentive to turn this percentage into dollars');
        break;
      case 'amount':
        target = c.weight.value;
        weight = ti ? target / ti : null;
        break;
      case 'quota':
        if (c.quota === null || c.quota <= 0) cIssues.push('A quota-weighted component needs a quota');
        else if (quotaSum > 0) weight = (remainder * c.quota) / quotaSum;
        if (ti === null) cIssues.push('Set the plan target incentive so quota-weighted components can be sized');
        else if (weight !== null) target = ti * weight;
        break;
    }
    if (weight !== null && weight < 0) cIssues.push('Weight cannot be negative');
    if (c.quota === null || c.quota <= 0) {
      if (c.weight.kind !== 'quota') cIssues.push('Set a quota to get an on-target rate');
    }
    const rate = target !== null && c.quota !== null && c.quota > 0 ? clean(target / c.quota) : null;
    const tiers: PlanTiers | null =
      rate !== null && c.tiers.rows.length
        ? { mode: c.tiers.mode, basis: 'percent_of_quota', scaleParam: 'quota', rows: c.tiers.rows.map((r) => ({ from: r.from, rate: clean(rate * r.rate) })) }
        : null;
    return { id: c.id, name: c.name, key: componentKey(c.name), weight, targetIncentive: target, quota: c.quota, rate, tiers, issues: cIssues };
  });

  const weights = resolved.map((r) => r.weight);
  const weightTotal = weights.every((w): w is number => w !== null) && weights.length ? weights.reduce((a, b) => a + b, 0) : null;
  if (comps.length && ti === null) issues.push('Set the plan target incentive (variable pay at 100% attainment)');
  if (fixedShare > 1 + EPS) issues.push(`Percent and amount weights add up to ${Math.round(fixedShare * 1000) / 10}%, more than the target incentive`);
  else if (weightTotal !== null && Math.abs(weightTotal - 1) > EPS) issues.push(`Weights add up to ${Math.round(weightTotal * 1000) / 10}%, not 100%`);
  if (quotaComps.length && quotaSum <= 0 && ti !== null) issues.push('Quota-weighted components need quotas to share the remainder');
  const keys = new Map<string, number>();
  for (const r of resolved) keys.set(r.key, (keys.get(r.key) ?? 0) + 1);
  for (const [k, n] of keys) if (n > 1 && k) issues.push(`More than one component is called "${k}"`);

  return { targetIncentive: ti, components: resolved, weightTotal, issues };
}

/** Attainment as a fraction of the component quota (null without a quota). */
export function componentAttainment(attained: number, c: ResolvedComponent): number | null {
  return c.quota !== null && c.quota > 0 ? attained / c.quota : null;
}

/**
 * Payout for `attained` (in the component's units) under its tiers; a
 * component with no tiers pays the on-target rate on everything.
 */
export function componentPayout(attained: number, c: ResolvedComponent): number | null {
  if (c.rate === null) return null;
  if (!c.tiers) return attained * c.rate;
  return tierPayout(attained, c.tiers, c.quota);
}

/** The commission rate in force at `attained` (the highest tier reached × the on-target rate). */
export function componentRate(attained: number, c: ResolvedComponent): number | null {
  if (c.rate === null) return null;
  if (!c.tiers) return c.rate;
  return tierRate(attained, c.tiers, c.quota);
}

/** Find a component by key or name, case-insensitively. */
export function findComponent(components: ResolvedComponent[], ref: string): ResolvedComponent | null {
  const k = componentKey(ref);
  return components.find((c) => c.key === k) ?? null;
}
