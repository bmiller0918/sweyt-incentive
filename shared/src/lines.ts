// Commission lines: one line per person per deal, with a deal that crosses a
// tier threshold split into one line per band (base rate up to quota, the
// accelerated rate above it). Pure: deals and a plan lookup in, lines out.
//
// Attainment is cumulative per payee over the deals given, in close-date
// order, so the caller decides the attainment window by choosing which deals
// to pass (e.g. the fiscal year). Each payee's rate comes from the plan in
// force on the deal's date, so plan changes mid-year take effect on the day
// they start.
import type { DatedPlanLookup, ResolvedRep } from './calc.js';
import { tierBands, tierRate } from './tiers.js';

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
}

export type LineMethod =
  /** A slice of the deal paid at one tier's rate (tiered plan, marginal mode). */
  | 'tier'
  /** The whole deal at the highest tier reached (tiered plan, whole-amount mode). */
  | 'whole'
  /** The whole deal at plan.rate (no tier table). */
  | 'flat'
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

      const none = (note: string, planName: string | null = plan?.planName ?? null): CommissionLine => ({
        ...base,
        payee,
        role: p.role,
        planName,
        method: 'none',
        tierFrom: null,
        tierTo: null,
        amount,
        rate: null,
        payout: null,
        cumulativeBefore: before,
        cumulativeAfter: after,
        split: false,
        note,
      });

      if (amount === null) {
        lines.push(none('Deal has no amount'));
        continue;
      }
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
      cumulative.set(k, after);

      const tiers = plan.tiers;
      if (tiers && tiers.rows.length) {
        const quota = quotaOf(rep, plan);
        const bands = tierBands(tiers, quota);
        if (!bands) {
          lines.push(none('Tier thresholds are a % of quota, but no quota is set'));
          warnings.add(`${name}'s plan "${plan.planName}" needs a quota for its tiers.`);
          continue;
        }
        if (tiers.mode === 'whole') {
          const rate = tierRate(after, tiers, quota) ?? 0;
          const band = [...bands].reverse().find((b) => after >= b.from) ?? null;
          lines.push({
            ...base,
            payee,
            role: p.role,
            planName: plan.planName,
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
          });
          continue;
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
        for (const s of slices) {
          lines.push({
            ...base,
            payee,
            role: p.role,
            planName: plan.planName,
            method: 'tier',
            tierFrom: s.from,
            tierTo: s.to,
            amount: roundCents(s.amount),
            rate: s.rate,
            payout: roundCents(s.amount * s.rate),
            cumulativeBefore: before,
            cumulativeAfter: after,
            split,
            note: split ? 'Deal crossed a tier threshold and was split' : null,
          });
        }
        continue;
      }

      const rate = plan.params.rate;
      if (typeof rate !== 'number') {
        lines.push(none('Plan has neither a tier table nor a numeric "rate" parameter'));
        warnings.add(`Plan "${plan.planName}" has no tiers and no rate.`);
        continue;
      }
      lines.push({
        ...base,
        payee,
        role: p.role,
        planName: plan.planName,
        method: 'flat',
        tierFrom: null,
        tierTo: null,
        amount,
        rate,
        payout: roundCents(amount * rate),
        cumulativeBefore: before,
        cumulativeAfter: after,
        split: false,
        note: null,
      });
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
