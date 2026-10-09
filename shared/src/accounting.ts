// Accounting subledger over commission lines: what to accrue each payroll
// month, how much of it is capitalized (contract acquisition cost) versus
// expensed (e.g. BDRs), a straight-line amortization schedule per line, the
// capitalized-balance rollforward, and the journal entries that tie to it.
//
// Rules, from the design-partner conversation:
// - A commission is accrued in the month it is approved for payment (its
//   pay month). Held amounts are not booked at all.
// - The payee's department decides the treatment: expensed for lead-gen
//   roles, capitalized for everyone else.
// - Capitalized amounts amortize straight-line, either over the contract
//   term from the subscription start (today's practice) or over one
//   estimated customer life from the pay month (the practical expedient).
import { roundCents } from './lines.js';

export type CostTreatment = 'capitalize' | 'expense';
export type AmortizationMethod = 'contract_term' | 'customer_life';

export interface AccountingPolicy {
  method: AmortizationMethod;
  /** Months, used by customer_life (e.g. 48 for four years). */
  customerLifeMonths: number;
  /** Fallback term when a contract_term line has no term in the data. */
  defaultTermMonths: number;
}

/** What the subledger needs to know about one commission line. */
export interface AccountingLineInput {
  lineId: number;
  dealKey: string | null;
  payee: string;
  role: string;
  /** From the payee's employee type; "Unassigned" when unknown. */
  department: string;
  treatment: CostTreatment;
  payout: number | null;
  /** pay | hold | released */
  status: string;
  /** YYYY-MM; null while on hold. */
  payMonth: string | null;
  /** YYYY-MM-DD subscription start from the deal, when the data has it. */
  contractStart: string | null;
  termMonths: number | null;
}

export interface AccrualCell {
  payMonth: string;
  department: string;
  capitalized: number;
  expensed: number;
  total: number;
  lines: number;
}

export interface ScheduleLine {
  lineId: number;
  dealKey: string | null;
  payee: string;
  department: string;
  amount: number;
  /** YYYY-MM the asset was recognized (pay month). */
  capitalizedMonth: string;
  /** YYYY-MM first month of amortization. */
  startMonth: string;
  endMonth: string;
  months: number;
  /** YYYY-MM -> amortization expense that month. */
  byMonth: Record<string, number>;
}

export interface RollforwardRow {
  month: string;
  opening: number;
  additions: number;
  amortization: number;
  closing: number;
}

export interface JournalLine {
  account: string;
  department: string | null;
  debit: number;
  credit: number;
}

export interface JournalEntry {
  month: string;
  memo: string;
  lines: JournalLine[];
}

export interface SubledgerResult {
  policy: AccountingPolicy;
  accrual: AccrualCell[];
  schedule: ScheduleLine[];
  rollforward: RollforwardRow[];
  entries: JournalEntry[];
  /** Lines excluded and why (on hold, no payout, no pay month). */
  excluded: { lineId: number; reason: string }[];
  warnings: string[];
}

export const ACCOUNTS = {
  deferred: 'Deferred commissions (capitalized contract costs)',
  expense: 'Commission expense',
  amortization: 'Commission amortization expense',
  accrued: 'Accrued commissions',
} as const;

/** "2026-03" + 2 -> "2026-05". */
export function addMonths(ym: string, n: number): string {
  const [y, m] = ym.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}

export function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  return ty * 12 + tm - (fy * 12 + fm);
}

/**
 * Straight-line amounts for `amount` over `months` starting at `startMonth`.
 * Each month is rounded to cents; the last month absorbs the remainder so
 * the schedule always sums exactly to the amount.
 */
export function straightLine(amount: number, startMonth: string, months: number): Record<string, number> {
  const out: Record<string, number> = {};
  const n = Math.max(1, Math.round(months));
  const per = roundCents(amount / n);
  let booked = 0;
  for (let i = 0; i < n; i++) {
    const v = i === n - 1 ? roundCents(amount - booked) : per;
    out[addMonths(startMonth, i)] = v;
    booked = roundCents(booked + v);
  }
  return out;
}

export function buildSubledger(lines: AccountingLineInput[], policy: AccountingPolicy): SubledgerResult {
  const excluded: SubledgerResult['excluded'] = [];
  const warnings = new Set<string>();
  const accrualMap = new Map<string, AccrualCell>();
  const schedule: ScheduleLine[] = [];

  for (const l of lines) {
    if (l.status === 'hold') {
      excluded.push({ lineId: l.lineId, reason: 'On hold: not accrued until released' });
      continue;
    }
    if (l.payout === null) {
      excluded.push({ lineId: l.lineId, reason: 'No payout calculated' });
      continue;
    }
    if (!l.payMonth) {
      excluded.push({ lineId: l.lineId, reason: 'No pay month (deal has no close date)' });
      continue;
    }
    const key = `${l.payMonth}\u0001${l.department}`;
    const cell = accrualMap.get(key) ?? { payMonth: l.payMonth, department: l.department, capitalized: 0, expensed: 0, total: 0, lines: 0 };
    if (l.treatment === 'expense') cell.expensed = roundCents(cell.expensed + l.payout);
    else cell.capitalized = roundCents(cell.capitalized + l.payout);
    cell.total = roundCents(cell.total + l.payout);
    cell.lines++;
    accrualMap.set(key, cell);

    if (l.treatment === 'capitalize' && l.payout !== 0) {
      let startMonth: string;
      let months: number;
      if (policy.method === 'customer_life') {
        startMonth = l.payMonth;
        months = policy.customerLifeMonths;
      } else {
        startMonth = l.contractStart?.slice(0, 7) ?? l.payMonth;
        if (!l.contractStart) warnings.add('Some capitalized lines have no subscription start date; amortization starts in their pay month.');
        months = l.termMonths ?? policy.defaultTermMonths;
        if (l.termMonths === null) warnings.add(`Some capitalized lines have no contract term; the default of ${policy.defaultTermMonths} months was used.`);
      }
      const byMonth = straightLine(l.payout, startMonth, months);
      schedule.push({
        lineId: l.lineId,
        dealKey: l.dealKey,
        payee: l.payee,
        department: l.department,
        amount: l.payout,
        capitalizedMonth: l.payMonth,
        startMonth,
        endMonth: addMonths(startMonth, Math.max(1, Math.round(months)) - 1),
        months: Math.max(1, Math.round(months)),
        byMonth,
      });
    }
  }

  const accrual = [...accrualMap.values()].sort((a, b) => a.payMonth.localeCompare(b.payMonth) || a.department.localeCompare(b.department));

  // Rollforward: every month from the first capitalization to the last amortization.
  const months = new Set<string>();
  for (const s of schedule) {
    months.add(s.capitalizedMonth);
    for (const m of Object.keys(s.byMonth)) months.add(m);
  }
  const rollforward: RollforwardRow[] = [];
  if (months.size) {
    const sorted = [...months].sort();
    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    let balance = 0;
    for (let m = first; m <= last; m = addMonths(m, 1)) {
      const additions = roundCents(schedule.filter((s) => s.capitalizedMonth === m).reduce((a, s) => a + s.amount, 0));
      const amortization = roundCents(schedule.reduce((a, s) => a + (s.byMonth[m] ?? 0), 0));
      const opening = balance;
      balance = roundCents(opening + additions - amortization);
      rollforward.push({ month: m, opening, additions, amortization, closing: balance });
    }
  }

  // Journal entries: one accrual entry per pay month, one amortization entry per month.
  const entries: JournalEntry[] = [];
  const payMonths = [...new Set(accrual.map((c) => c.payMonth))].sort();
  for (const m of payMonths) {
    const cells = accrual.filter((c) => c.payMonth === m);
    const lines: JournalLine[] = [];
    for (const c of cells) {
      if (c.capitalized) lines.push({ account: ACCOUNTS.deferred, department: c.department, debit: c.capitalized, credit: 0 });
      if (c.expensed) lines.push({ account: ACCOUNTS.expense, department: c.department, debit: c.expensed, credit: 0 });
    }
    const total = roundCents(cells.reduce((a, c) => a + c.total, 0));
    lines.push({ account: ACCOUNTS.accrued, department: null, debit: 0, credit: total });
    entries.push({ month: m, memo: `Commissions approved for ${m} payroll`, lines });
  }
  for (const r of rollforward) {
    if (!r.amortization) continue;
    const byDept = new Map<string, number>();
    for (const s of schedule) {
      const v = s.byMonth[r.month];
      if (v) byDept.set(s.department, roundCents((byDept.get(s.department) ?? 0) + v));
    }
    const lines: JournalLine[] = [...byDept.entries()].sort().map(([department, v]) => ({ account: ACCOUNTS.amortization, department, debit: v, credit: 0 }));
    lines.push({ account: ACCOUNTS.deferred, department: null, debit: 0, credit: r.amortization });
    entries.push({ month: r.month, memo: `Amortization of capitalized commissions for ${r.month}`, lines });
  }
  entries.sort((a, b) => a.month.localeCompare(b.month) || (a.memo < b.memo ? -1 : 1));

  return { policy, accrual, schedule, rollforward, entries, excluded, warnings: [...warnings] };
}
