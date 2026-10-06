// Tier tables on comp plans: "from X pay rate R". Used by the TIER() and
// TIER_RATE() formula functions.
import { z } from 'zod';

export const tierRowSchema = z.object({
  /** Lower bound of the tier (inclusive), in dollars or as a fraction of quota. */
  from: z.number(),
  /** Rate as a fraction, e.g. 0.08 for 8%. */
  rate: z.number(),
});

export const planTiersSchema = z.object({
  /**
   * marginal: each tier's rate applies only to the slice between its
   *   threshold and the next (accelerators).
   * whole: the highest tier reached applies its rate to the entire amount.
   */
  mode: z.enum(['marginal', 'whole']).default('marginal'),
  /** What thresholds are measured in. percent_of_quota uses plan.quota. */
  basis: z.enum(['amount', 'percent_of_quota']).default('amount'),
  rows: z.array(tierRowSchema).default([]),
});
export type PlanTiers = z.infer<typeof planTiersSchema>;

export function emptyTiers(): PlanTiers {
  return { mode: 'marginal', basis: 'amount', rows: [] };
}

/** Sorted tiers with thresholds converted to amounts; null if unusable. */
function normalize(tiers: PlanTiers, quota: number | null): { from: number; rate: number }[] | null {
  if (!tiers.rows.length) return null;
  if (tiers.basis === 'percent_of_quota' && (quota === null || quota <= 0)) return null;
  const scale = tiers.basis === 'percent_of_quota' ? (quota as number) : 1;
  return [...tiers.rows].map((r) => ({ from: r.from * scale, rate: r.rate })).sort((a, b) => a.from - b.from);
}

/** The payout for `value` under the tier table. */
export function tierPayout(value: number, tiers: PlanTiers, quota: number | null): number | null {
  const rows = normalize(tiers, quota);
  if (!rows) return null;
  if (tiers.mode === 'whole') {
    const rate = tierRate(value, tiers, quota);
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
export function tierRate(value: number, tiers: PlanTiers, quota: number | null): number | null {
  const rows = normalize(tiers, quota);
  if (!rows) return null;
  let rate = 0;
  for (const r of rows) if (value >= r.from) rate = r.rate;
  return rate;
}
