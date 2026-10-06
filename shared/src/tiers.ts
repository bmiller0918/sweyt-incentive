// Tier tables on comp plans: "from X pay rate R". Used by the TIER() and
// TIER_RATE() formula functions.
import { z } from 'zod';

export const tierRowSchema = z.object({
  /** Lower bound of the tier (inclusive), in the threshold type's units. */
  from: z.number(),
  /** Rate as a fraction, e.g. 0.08 for 8%. */
  rate: z.number(),
});

export const planTiersSchema = z.object({
  /**
   * Payout method.
   * marginal: each tier's rate applies only to the slice between its
   *   threshold and the next (accelerators).
   * whole: the highest tier reached applies its rate to the entire amount.
   */
  mode: z.enum(['marginal', 'whole']).default('marginal'),
  /**
   * Threshold type key: a built-in ('amount', 'percent_of_quota', 'count')
   * or a custom type's key. Only `scaleParam` affects the math.
   */
  basis: z.string().default('amount'),
  /**
   * When set, thresholds are fractions of the plan parameter with this name
   * (e.g. 'quota': 0.8 means 80% of plan.quota). Resolved from the
   * threshold type when the plan is loaded.
   */
  scaleParam: z.string().nullable().optional(),
  rows: z.array(tierRowSchema).default([]),
});
export type PlanTiers = z.infer<typeof planTiersSchema>;

/** Threshold types every workspace starts with. */
export const BUILTIN_THRESHOLD_TYPES = [
  { key: 'amount', name: 'Dollars', unit: '$', scaleParam: null },
  { key: 'percent_of_quota', name: '% of quota', unit: '%', scaleParam: 'quota' },
  { key: 'count', name: 'Count', unit: 'units', scaleParam: null },
] as const;

export function emptyTiers(): PlanTiers {
  return { mode: 'marginal', basis: 'amount', scaleParam: null, rows: [] };
}

/** The plan parameter thresholds scale by, honouring the legacy basis value. */
export function tierScaleParam(tiers: PlanTiers): string | null {
  if (tiers.scaleParam !== undefined) return tiers.scaleParam;
  return tiers.basis === 'percent_of_quota' ? 'quota' : null;
}

/** Sorted tiers with thresholds converted to absolute values; null if unusable. */
function normalize(tiers: PlanTiers, scale: number | null): { from: number; rate: number }[] | null {
  if (!tiers.rows.length) return null;
  const param = tierScaleParam(tiers);
  if (param && (scale === null || scale <= 0)) return null;
  const k = param ? (scale as number) : 1;
  return [...tiers.rows].map((r) => ({ from: r.from * k, rate: r.rate })).sort((a, b) => a.from - b.from);
}

/**
 * The payout for `value` under the tier table. `scale` is the value of the
 * plan parameter thresholds are relative to (e.g. the quota), when any.
 */
export function tierPayout(value: number, tiers: PlanTiers, scale: number | null): number | null {
  const rows = normalize(tiers, scale);
  if (!rows) return null;
  if (tiers.mode === 'whole') {
    const rate = tierRate(value, tiers, scale);
    return rate === null ? null : value * rate;
  }
  let payout = 0;
  for (let i = 0; i < rows.length; i++) {
    const lo = rows[i].from;
    const hi = i + 1 < rows.length ? rows[i + 1].from : Infinity;
    const slice = Math.min(value, hi) - lo;
    if (slice > 0) payout += slice * rows[i].rate;
  }
  return payout;
}

/** The rate of the highest tier whose threshold `value` has reached (0 below the first tier). */
export function tierRate(value: number, tiers: PlanTiers, scale: number | null): number | null {
  const rows = normalize(tiers, scale);
  if (!rows) return null;
  let rate = 0;
  for (const r of rows) if (value >= r.from) rate = r.rate;
  return rate;
}
