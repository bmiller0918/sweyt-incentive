// Quota sections on a comp plan: count, dollars, percent of quota and percent
// of margin. Each section either does not apply or carries its own tier
// table, and every section that applies pays its own commission line.
//
// Pure: the plan's sections in, tier tables and labels out. The commission
// engine (lines.ts) walks the sections; plans saved before sections existed
// carry `quotas: null` and keep their legacy tiers / rate.
import { z } from 'zod';
import { type PlanTiers } from './tiers.js';

export const QUOTA_SECTION_KEYS = ['count', 'dollars', 'percentOfQuota', 'percentOfMargin'] as const;
export type QuotaSectionKey = (typeof QUOTA_SECTION_KEYS)[number];

export const quotaRowSchema = z.object({
  /**
   * Lower bound (inclusive). count: units; dollars: dollars;
   * percentOfQuota: fraction of quota (0.8 = 80%); percentOfMargin: the
   * deal's gross margin as a fraction of its amount (0.15 = 15% GM).
   */
  from: z.number(),
  /**
   * count: dollars per unit; dollars / percentOfQuota: fraction of the
   * amount; percentOfMargin: fraction of the deal's gross profit.
   */
  rate: z.number(),
});

export const quotaSectionSchema = z.object({
  applies: z.boolean().default(false),
  /**
   * The quota. count: units; dollars: dollars (both informational, shown
   * to formulas as plan.count_quota / plan.dollars_quota); percentOfQuota:
   * the dollar quota thresholds are a share of (an employee's own quota
   * overrides it). Unused for percentOfMargin.
   */
  target: z.number().nullable().default(null),
  /** marginal: each tier's rate pays its own slice; whole: the tier reached re-rates the deal. Margin tiers are always per deal. */
  mode: z.enum(['marginal', 'whole']).default('marginal'),
  rows: z.array(quotaRowSchema).default([]),
});
export type QuotaSection = z.infer<typeof quotaSectionSchema>;

export const planQuotasSchema = z.object({
  count: quotaSectionSchema.default({}),
  dollars: quotaSectionSchema.default({}),
  percentOfQuota: quotaSectionSchema.default({}),
  percentOfMargin: quotaSectionSchema.default({}),
});
export type PlanQuotas = z.infer<typeof planQuotasSchema>;

export const QUOTA_SECTIONS: { key: QuotaSectionKey; label: string; hint: string }[] = [
  { key: 'count', label: 'Count quota', hint: 'Units sold (one per deal). Each tier pays a dollar amount per unit.' },
  { key: 'dollars', label: 'Dollars quota', hint: 'Deal amount in dollars. Each tier pays a percent of the amount.' },
  { key: 'percentOfQuota', label: 'Percent of quota', hint: 'Deal amount against the quota. Tiers start at a percent of quota and pay a percent of the amount.' },
  { key: 'percentOfMargin', label: 'Percent of margin', hint: 'Gross profit on each deal (amount minus cost). The deal’s margin % picks the tier, which pays a percent of the gross profit.' },
];

export function emptySection(): QuotaSection {
  return { applies: false, target: null, mode: 'marginal', rows: [] };
}

export function emptyQuotas(): PlanQuotas {
  return { count: emptySection(), dollars: emptySection(), percentOfQuota: emptySection(), percentOfMargin: emptySection() };
}

/** Sections that apply, in display order. */
export function activeSections(q: PlanQuotas): { key: QuotaSectionKey; label: string; section: QuotaSection }[] {
  return QUOTA_SECTIONS.filter((s) => q[s.key]?.applies).map((s) => ({ key: s.key, label: s.label, section: q[s.key] }));
}

/** A section as a tier table for the tier engine (thresholds of percentOfQuota scale by the quota). */
export function sectionTiers(key: QuotaSectionKey, s: QuotaSection): PlanTiers {
  const rows = s.rows.map((r) => ({ from: r.from, rate: r.rate }));
  switch (key) {
    case 'count':
      return { mode: s.mode, basis: 'count', scaleParam: null, rows };
    case 'dollars':
      return { mode: s.mode, basis: 'amount', scaleParam: null, rows };
    case 'percentOfQuota':
      return { mode: s.mode, basis: 'percent_of_quota', scaleParam: 'quota', rows };
    case 'percentOfMargin':
      return { mode: 'whole', basis: 'margin_percent', scaleParam: null, rows };
  }
}

/**
 * Sections for a plan saved before sections existed: its tier table goes to
 * the section matching its threshold type, and a flat plan.rate becomes a
 * one-tier dollars quota. Custom threshold types map by their scaling (a %
 * of a parameter is percent of quota) and unit ('$' is dollars, else count).
 */
export function quotasFromLegacy(plan: { tiers?: PlanTiers | null; params?: Record<string, unknown> }, typeUnit?: string | null): PlanQuotas {
  const q = emptyQuotas();
  const tiers = plan.tiers;
  const quota = plan.params?.quota;
  if (tiers && tiers.rows.length) {
    const scaled = tiers.scaleParam !== undefined && tiers.scaleParam !== null ? true : tiers.basis === 'percent_of_quota';
    const key: QuotaSectionKey = scaled ? 'percentOfQuota' : tiers.basis === 'amount' || typeUnit === '$' ? 'dollars' : 'count';
    q[key] = { applies: true, target: key === 'percentOfQuota' && typeof quota === 'number' ? quota : null, mode: tiers.mode, rows: tiers.rows.map((r) => ({ ...r })) };
    return q;
  }
  const rate = plan.params?.rate;
  if (typeof rate === 'number') q.dollars = { applies: true, target: null, mode: 'marginal', rows: [{ from: 0, rate }] };
  return q;
}

/**
 * What TIER() / TIER_RATE() in Calculate use for a sectioned plan: percent
 * of quota first, then dollars, then count. Null when none applies.
 */
export function primaryTiers(q: PlanQuotas): PlanTiers | null {
  for (const key of ['percentOfQuota', 'dollars', 'count'] as const) {
    if (q[key]?.applies && q[key].rows.length) return sectionTiers(key, q[key]);
  }
  return null;
}
