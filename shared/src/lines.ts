// Commission lines: one line per person per deal, with a deal that crosses a
// tier threshold split into one line per band (base rate up to quota, the
// accelerated rate above it). Pure: deals and a plan lookup in, lines out.
//
// Attainment is cumulative per payee over the deals given, in close-date
// order, so the caller decides the attainment window by choosing which deals
// to pass (e.g. the fiscal year). Each payee's rate comes from the plan in
// force on the deal's date, so plan changes mid-year take effect on the day
// they start.
//
// Plans with weighted components pay one line per component instead: the
// run maps each component to a column (deal.measures, keyed by component
// key), attainment accrues per payee per component against the component's
// quota, and the component's attainment tiers scale its on-target rate.
//
// Plans with quota sections (count, dollars, percent of quota, percent of
// margin) pay one line per section that applies, each with its own
// attainment. Margin tiers are per deal: the deal's margin % picks the rate,
// which pays on its gross profit.
import type { DatedPlanLookup, ResolvedRep } from './calc.js';
import { resolveStructure } from './components.js';
import { activeSections, sectionTiers } from './quotas.js';
import { tierBands, tierRate, type PlanTiers } from './tiers.js';

export interface DealPayee {
  /** Which column the person came from: "Rep", "SE", "Manager", ... */
  role: string;
  name: string;
}

export interface DealInput {
  /** Row index in the source import. */
  rowIndex: number;
  /** A stable deal identifier when the data has one (e.g. "Deal ID"). */
  dealKey: string | null;
  /** ISO date (YYYY-MM-DD) or null when the row has none. */
  date: string | null;
  amount: number | null;
  payees: DealPayee[];
  /**
   * Per-component values from the run's component → column mapping, keyed
   * by component key ("new_arr"). A key that is absent is unmapped; null is
   * a blank cell (nothing to pay for that component on this deal).
   */
  measures?: Record<string, number | null>;
  /**
   * Gross profit (margin dollars) from the run's margin column, for
   * percent-of-margin quotas. Absent when the run maps no margin column;
   * null for a blank cell.
   */
  margin?: number | null;
}

export type LineMethod =
  /** A slice of the deal paid at one tier's rate (tiered plan, marginal mode). */
  | 'tier'
  /** The whole deal at the highest tier reached (tiered plan, whole-amount mode). */
  | 'whole'
  /** The whole deal at plan.rate (no tier table). */
  | 'flat'
  /** The deal's gross profit at the rate its margin % reaches (percent-of-margin quota). */
  | 'margin'
  /** Nothing could be calculated; see `note`. */
  | 'none';

export interface CommissionLine {
  rowIndex: number;
  dealKey: string | null;
  dealDate: string | null;
  dealAmount: number | null;
  payee: string;
  role: string;
  planName: string | null;
  /** The plan component or quota section this line pays under; null for plan-level lines. */
  component: string | null;
  method: LineMethod;
  /** Tier band this line falls in (absolute thresholds), when tiered. */
  tierFrom: number | null;
  tierTo: number | null;
  /** The portion of the deal this line pays on. Equals dealAmount unless split. */
  amount: number | null;
  rate: number | null;
  /** amount × rate, rounded to cents. */
  payout: number | null;
  /** Payee's cumulative attainment before and after this deal. */
  cumulativeBefore: number;
  cumulativeAfter: number;
  /** True when the deal was split across tiers for this payee. */
  split: boolean;
  /** Why no payout, or what to check. */
  note: string | null;
}

export interface PayeeTotal {
  payee: string;
  role: string;
  planName: string | null;
  deals: number;
  amount: number;
  payout: number;
  /** Lines for this payee that produced no payout. */
  unpaid: number;
}

export interface LinesResult {
  lines: CommissionLine[];
  totals: PayeeTotal[];
  dealCount: number;
  totalPayout: number;
  warnings: string[];
}

export interface LinesOptions {
  /** Date used to resolve plans for deals with no date. Defaults to today. */
  defaultAsOf?: string;
  /** Starting attainment per payee (lower-cased name), e.g. carried in from a prior run. */
  openingAttainment?: Record<string, number>;
}

/** Round half away from zero to cents, tolerant of float noise (0.285 -> 0.29). */
export function roundCents(n: number): number {
  const sign = n < 0 ? -1 : 1;
  return (sign * Math.round(Math.abs(n) * 100 + 1e-9)) / 100;
}

const key = (name: string) => name.trim().toLowerCase();

function quotaOf(rep: ResolvedRep, plan: ResolvedRep['plans'][string]): number | null {
  const q = rep.employee.quota ?? plan.params.quota;
  return typeof q === 'number' ? q : null;
}

type LineContext = Pick<CommissionLine, 'rowIndex' | 'dealKey' | 'dealDate' | 'dealAmount' | 'payee' | 'role' | 'planName' | 'component'>;

function flatLine(ctx: LineContext, amount: number, rate: number, before: number, after: number): CommissionLine {
  return { ...ctx, method: 'flat', tierFrom: null, tierTo: null, amount, rate, payout: roundCents(amount * rate), cumulativeBefore: before, cumulativeAfter: after, split: false, note: null };
}

/**
 * Lines for `amount` under a tier table, given the payee's attainment before
 * and after it. Marginal mode walks the bands the amount spans (one line per
 * band); whole mode pays everything at the tier reached. `tiers` must be
 * usable with `scale` (see tierBands).
 */
function tieredLines(ctx: LineContext, amount: number, before: number, after: number, tiers: PlanTiers, scale: number | null): CommissionLine[] {
  const bands = tierBands(tiers, scale)!;
  if (tiers.mode === 'whole') {
    const rate = tierRate(after, tiers, scale) ?? 0;
    const band = [...bands].reverse().find((b) => after >= b.from) ?? null;
    return [
      {
        ...ctx,
        method: 'whole',
        tierFrom: band?.from ?? null,
        tierTo: band ? (bands[bands.indexOf(band) + 1]?.from ?? null) : (bands[0]?.from ?? null),
        amount,
        rate,
        payout: roundCents(amount * rate),
        cumulativeBefore: before,
        cumulativeAfter: after,
        split: false,
        note: null,
      },
    ];
  }
  // Marginal: walk the bands the deal spans. A band starting above 0
  // implies a 0% band below it, so nothing is silently dropped, and the
  // lowest band extends downward so credit memos that push attainment
  // negative still unwind at the base rate.
  const edges = bands[0].from > 0 ? [{ from: 0, rate: 0 }, ...bands] : bands;
  const lo = Math.min(before, after);
  const hi = Math.max(before, after);
  const sign = amount < 0 ? -1 : 1;
  const slices: { from: number; to: number | null; rate: number; amount: number }[] = [];
  for (let i = 0; i < edges.length; i++) {
    const bFrom = i === 0 ? -Infinity : edges[i].from;
    const bTo = i + 1 < edges.length ? edges[i + 1].from : Infinity;
    const slice = Math.min(hi, bTo) - Math.max(lo, bFrom);
    if (slice > 0) slices.push({ from: edges[i].from, to: bTo === Infinity ? null : bTo, rate: edges[i].rate, amount: sign * slice });
  }
  if (!slices.length) {
    // Zero-amount deal: record it against the band it sits in.
    const band = [...edges].reverse().find((b) => after >= b.from) ?? edges[0];
    slices.push({ from: band.from, to: edges[edges.indexOf(band) + 1]?.from ?? null, rate: band.rate, amount: 0 });
  }
  const split = slices.length > 1;
  return slices.map((s) => ({
    ...ctx,
    method: 'tier' as const,
    tierFrom: s.from,
    tierTo: s.to,
    amount: roundCents(s.amount),
    rate: s.rate,
    payout: roundCents(s.amount * s.rate),
    cumulativeBefore: before,
    cumulativeAfter: after,
    split,
    note: split ? 'Deal crossed a tier threshold and was split' : null,
  }));
}

export function computeCommissionLines(deals: DealInput[], lookup: DatedPlanLookup, opts: LinesOptions = {}): LinesResult {
  const defaultAsOf = opts.defaultAsOf ?? new Date().toISOString().slice(0, 10);
  const cumulative = new Map<string, number>(Object.entries(opts.openingAttainment ?? {}).map(([k, v]) => [key(k), v]));
  const lines: CommissionLine[] = [];
  const warnings = new Set<string>();

  // Oldest first so attainment accrues in the order deals closed; undated deals last.
  const ordered = [...deals].sort((a, b) => {
    if (a.date === b.date) return a.rowIndex - b.rowIndex;
    if (a.date === null) return 1;
    if (b.date === null) return -1;
    return a.date < b.date ? -1 : 1;
  });

  for (const deal of ordered) {
    const base = {
      rowIndex: deal.rowIndex,
      dealKey: deal.dealKey,
      dealDate: deal.date,
      dealAmount: deal.amount,
    };
    if (deal.date === null) warnings.add('Some deals have no close date; their plans were resolved as of the run date and they were processed last.');

    for (const p of deal.payees) {
      const name = p.name.trim();
      if (!name) continue;
      const k = key(name);
      const before = cumulative.get(k) ?? 0;
      const amount = deal.amount;
      const after = before + (amount ?? 0);
      const rep = lookup(name, deal.date ?? defaultAsOf);
      const plan = rep?.plans.plan ?? null;
      // Show the person as Employees spells them, however the data spelled it.
      const payee = rep?.employee.name ?? name;

      const none = (note: string, planName: string | null = plan?.planName ?? null, component: string | null = null, value: number | null = amount): CommissionLine => ({
        ...base,
        payee,
        role: p.role,
        planName,
        component,
        method: 'none',
        tierFrom: null,
        tierTo: null,
        amount: value,
        rate: null,
        payout: null,
        cumulativeBefore: before,
        cumulativeAfter: after,
        split: false,
        note,
      });

      if (!rep) {
        lines.push(none(`No employee named "${name}"`, null));
        warnings.add(`${name} is not in Employees, so nothing was calculated for them.`);
        continue;
      }
      if (!plan) {
        lines.push(none('No comp plan in force on this date', null));
        warnings.add(`${name} has no comp plan in force for some deals.`);
        continue;
      }

      const ctx = { ...base, payee, role: p.role, planName: plan.planName };

      // -- Quota sections: one line per section that applies ------------------
      if (plan.quotas) {
        const sections = activeSections(plan.quotas);
        if (!sections.length) {
          lines.push(none('No quota section applies on this plan'));
          warnings.add(`Plan "${plan.planName}" has no quota section that applies.`);
          continue;
        }
        for (const { key: sk, label, section } of sections) {
          const sctx = { ...ctx, component: label };
          if (!section.rows.length) {
            lines.push(none('Quota section has no tiers', plan.planName, label));
            warnings.add(`Plan "${plan.planName}": ${label} applies but has no tiers.`);
            continue;
          }
          const tiers = sectionTiers(sk, section);
          if (sk === 'percentOfMargin') {
            const margin = deal.margin;
            if (margin === undefined) {
              warnings.add(`Plan "${plan.planName}" pays on margin, but this run maps no margin column, so nothing was paid for it.`);
              continue;
            }
            if (margin === null) continue;
            const mk = `${k}\u0001margin`;
            const mBefore = cumulative.get(mk) ?? 0;
            const mAfter = mBefore + margin;
            cumulative.set(mk, mAfter);
            if (!amount) {
              lines.push({ ...none('Deal has no amount, so its margin % is unknown', plan.planName, label, margin), cumulativeBefore: mBefore, cumulativeAfter: mAfter });
              continue;
            }
            const gm = margin / amount;
            const bands = tierBands(tiers, null)!;
            const i = bands.reduce((at, b, j) => (gm >= b.from ? j : at), -1);
            const rate = i < 0 ? 0 : bands[i].rate;
            lines.push({
              ...sctx,
              method: 'margin',
              tierFrom: i < 0 ? null : bands[i].from,
              tierTo: i < 0 ? (bands[0]?.from ?? null) : (bands[i + 1]?.from ?? null),
              amount: margin,
              rate,
              payout: roundCents(margin * rate),
              cumulativeBefore: mBefore,
              cumulativeAfter: mAfter,
              split: false,
              note: i < 0 ? `Margin ${Math.round(gm * 1000) / 10}% is below the first tier` : null,
            });
            continue;
          }
          if (amount === null) {
            lines.push(none('Deal has no amount', plan.planName, label));
            continue;
          }
          // Count credits one unit per deal (a credit memo takes one back).
          const value = sk === 'count' ? (amount < 0 ? -1 : 1) : amount;
          const sKey = `${k}\u0001${sk}`;
          const sBefore = cumulative.get(sKey) ?? 0;
          const sAfter = sBefore + value;
          let scale: number | null = null;
          if (sk === 'percentOfQuota') {
            const q = rep.employee.quota ?? section.target ?? (typeof plan.params.quota === 'number' ? plan.params.quota : null);
            if (q === null || q <= 0) {
              lines.push({ ...none('Percent-of-quota tiers need a quota, but none is set', plan.planName, label, value), cumulativeBefore: sBefore, cumulativeAfter: sAfter });
              warnings.add(`${name}'s plan "${plan.planName}" needs a quota for its percent-of-quota tiers.`);
              continue;
            }
            scale = q;
          }
          cumulative.set(sKey, sAfter);
          lines.push(...tieredLines(sctx, value, sBefore, sAfter, tiers, scale));
        }
        continue;
      }

      // -- Weighted components: one line per mapped component ----------------
      if (plan.structure?.components.length) {
        const resolved = resolveStructure(plan.structure);
        for (const c of resolved.components) {
          const value = deal.measures?.[c.key];
          if (value === undefined) {
            warnings.add(`Component "${c.name}" of plan "${plan.planName}" is not mapped to a column, so nothing was paid for it.`);
            continue;
          }
          if (value === null) continue;
          const ck = `${k}\u0001${c.key}`;
          const cBefore = cumulative.get(ck) ?? 0;
          const cAfter = cBefore + value;
          if (c.rate === null) {
            lines.push({ ...none(c.issues[0] ?? 'Component cannot be priced', plan.planName, c.name, value), cumulativeBefore: cBefore, cumulativeAfter: cAfter });
            warnings.add(`Plan "${plan.planName}", component "${c.name}": ${c.issues[0] ?? 'cannot be priced'}.`);
            continue;
          }
          cumulative.set(ck, cAfter);
          if (c.tiers) lines.push(...tieredLines({ ...ctx, component: c.name }, value, cBefore, cAfter, c.tiers, c.quota));
          else lines.push(flatLine({ ...ctx, component: c.name }, value, c.rate, cBefore, cAfter));
        }
        continue;
      }

      // -- Plan-level: the deal amount under the plan's tiers or flat rate ---
      if (amount === null) {
        lines.push(none('Deal has no amount'));
        continue;
      }
      cumulative.set(k, after);

      const tiers = plan.tiers;
      if (tiers && tiers.rows.length) {
        const quota = quotaOf(rep, plan);
        if (!tierBands(tiers, quota)) {
          lines.push(none('Tier thresholds are a % of quota, but no quota is set'));
          warnings.add(`${name}'s plan "${plan.planName}" needs a quota for its tiers.`);
          continue;
        }
        lines.push(...tieredLines({ ...ctx, component: null }, amount, before, after, tiers, quota));
        continue;
      }

      const rate = plan.params.rate;
      if (typeof rate !== 'number') {
        lines.push(none('Plan has neither a tier table nor a numeric "rate" parameter'));
        warnings.add(`Plan "${plan.planName}" has no tiers and no rate.`);
        continue;
      }
      lines.push(flatLine({ ...ctx, component: null }, amount, rate, before, after));
    }
  }

  // Per-payee totals; a person counts once per deal even when split.
  const totals = new Map<string, PayeeTotal & { seen: Set<number> }>();
  for (const l of lines) {
    const k = `${key(l.payee)}\u0001${l.role}`;
    let t = totals.get(k);
    if (!t) {
      t = { payee: l.payee, role: l.role, planName: l.planName, deals: 0, amount: 0, payout: 0, unpaid: 0, seen: new Set() };
      totals.set(k, t);
    }
    if (!t.seen.has(l.rowIndex)) {
      t.seen.add(l.rowIndex);
      t.deals++;
      t.amount += l.dealAmount ?? 0;
    }
    if (l.payout === null) t.unpaid++;
    else t.payout = roundCents(t.payout + l.payout);
    if (!t.planName && l.planName) t.planName = l.planName;
  }

  const totalPayout = roundCents(lines.reduce((a, l) => a + (l.payout ?? 0), 0));
  return {
    lines,
    totals: [...totals.values()]
      .map(({ seen: _seen, ...t }) => ({ ...t, amount: roundCents(t.amount) }))
      .sort((a, b) => b.payout - a.payout || a.payee.localeCompare(b.payee)),
    dealCount: new Set(deals.map((d) => d.rowIndex)).size,
    totalPayout,
    warnings: [...warnings],
  };
}
