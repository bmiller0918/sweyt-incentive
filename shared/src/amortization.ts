// Amortization of capitalized commissions (ASC 340-40 / IFRS 15 costs to
// obtain a contract), as a register that is closed one month at a time.
//
// - A method says how one capitalized amount is spread over months:
//   straight-line over the contract term or a fixed benefit period, a
//   percentage per year (e.g. 20/30/50), a percentage per month, or
//   expensed immediately.
// - An amortization type says how a group of roles is treated (capitalize
//   or expense) and with which method; employee types point at one.
// - Closing a month books every commission line that pays that month (plus
//   late lines for months already closed) into the register, recognizes
//   the month's amortization, writes off impaired assets, splits the
//   balance into current and non-current, and produces the journals.
//
// Everything here is pure; the server persists assets and closed periods.
import { ACCOUNTS, addMonths, straightLine, type CostTreatment, type JournalEntry, type JournalLine } from './accounting.js';
import { roundCents } from './lines.js';

export type MethodKind = 'straight_line' | 'yearly_percent' | 'monthly_percent' | 'immediate';
/** straight_line: what sets the number of months. */
export type PeriodBasis = 'contract_term' | 'fixed_months';
/** The first month of amortization. */
export type StartBasis = 'contract_start' | 'pay_month' | 'month_after_pay';

export interface AmortizationMethodDef {
  kind: MethodKind;
  periodBasis: PeriodBasis;
  /** fixed_months: the benefit period (e.g. 48 for a four-year customer life). */
  months: number | null;
  /** contract_term: multiply the term to cover expected renewals (1 = term only). */
  termMultiplier: number;
  /** yearly_percent: % of the amount per 12-month year; must sum to 100. */
  yearPercents: number[];
  /** monthly_percent: % of the amount per month; must sum to 100. */
  monthPercents: number[];
  startBasis: StartBasis;
}

export interface NamedMethod {
  id: string;
  name: string;
  def: AmortizationMethodDef;
}

export interface GlAccount {
  number: string;
  name: string;
}

export interface AccountMap {
  deferredCurrent: GlAccount;
  deferredNoncurrent: GlAccount;
  commissionExpense: GlAccount;
  amortizationExpense: GlAccount;
  impairmentExpense: GlAccount;
  accruedCommissions: GlAccount;
}

export const DEFAULT_ACCOUNTS: AccountMap = {
  deferredCurrent: { number: '1450', name: 'Deferred commissions, current' },
  deferredNoncurrent: { number: '1750', name: 'Deferred commissions, non-current' },
  commissionExpense: { number: '6110', name: ACCOUNTS.expense },
  amortizationExpense: { number: '6120', name: ACCOUNTS.amortization },
  impairmentExpense: { number: '6125', name: 'Impairment of deferred commissions' },
  accruedCommissions: { number: '2150', name: ACCOUNTS.accrued },
};

export type ReclassMode = 'true_up' | 'reverse_rebook';

export interface AccountingSettings {
  /** Method for types that don't name one, and for lines with no type. */
  defaultMethodId: string | null;
  /** Fallback term when a contract_term method meets a deal with no term. */
  defaultTermMonths: number;
  /** ASC 340-40-25-4: expense when the amortization period is one year or less. */
  practicalExpedient: boolean;
  /** Split the balance into current (next 12 months) and non-current. */
  reclassEnabled: boolean;
  /**
   * true_up: one entry moving the change in the current portion.
   * reverse_rebook: reverse last month's reclass, then book this month's in full.
   */
  reclassMode: ReclassMode;
  accounts: AccountMap;
}

export const DEFAULT_SETTINGS: AccountingSettings = {
  defaultMethodId: null,
  defaultTermMonths: 12,
  practicalExpedient: false,
  reclassEnabled: true,
  reclassMode: 'true_up',
  accounts: DEFAULT_ACCOUNTS,
};

export interface AmortizationTypeDef {
  id: string;
  name: string;
  treatment: CostTreatment;
  /** null = the company default method. */
  methodId: string | null;
  /** Optional per-type GL overrides (e.g. a separate SE expense account). */
  expenseAccount: GlAccount | null;
  amortizationAccount: GlAccount | null;
}

/** Built-in methods, seeded once; users add their own. */
export const BUILTIN_METHODS: { key: string; name: string; description: string; def: AmortizationMethodDef }[] = [
  {
    key: 'contract_term',
    name: 'Straight-line over contract term',
    description: 'Evenly over the subscription term, starting with the subscription. The usual choice when renewal commissions are commensurate with the initial commission.',
    def: { kind: 'straight_line', periodBasis: 'contract_term', months: null, termMultiplier: 1, yearPercents: [], monthPercents: [], startBasis: 'contract_start' },
  },
  {
    key: 'customer_life_48',
    name: 'Straight-line over 4-year customer life',
    description: 'Evenly over an expected customer life including anticipated renewals. Use when renewal commissions are not commensurate (lower than the initial).',
    def: { kind: 'straight_line', periodBasis: 'fixed_months', months: 48, termMultiplier: 1, yearPercents: [], monthPercents: [], startBasis: 'pay_month' },
  },
  {
    key: 'ramped_20_30_50',
    name: 'Ramped 3-year: 20% / 30% / 50%',
    description: 'A percentage per contract year, spread evenly within each year. Fits ramped deals where revenue grows each year.',
    def: { kind: 'yearly_percent', periodBasis: 'contract_term', months: null, termMultiplier: 1, yearPercents: [20, 30, 50], monthPercents: [], startBasis: 'contract_start' },
  },
  {
    key: 'immediate',
    name: 'Expense immediately',
    description: 'No asset: the full amount is expensed in the month it is accrued. For costs that are not incremental to a contract, or under the one-year practical expedient.',
    def: { kind: 'immediate', periodBasis: 'contract_term', months: null, termMultiplier: 1, yearPercents: [], monthPercents: [], startBasis: 'pay_month' },
  },
];

/** Built-in amortization types, seeded once with a suggested employee-type match. */
export const BUILTIN_TYPES: { key: string; name: string; description: string; treatment: CostTreatment; methodKey: string | null; match: RegExp }[] = [
  {
    key: 'account_executive',
    name: 'Account Executives',
    description: 'Commissions earned on signed contracts are incremental costs to obtain them: capitalize and amortize.',
    treatment: 'capitalize',
    methodKey: null,
    match: /\b(ae|account exec|executive|closer|sales rep|rep)\b/i,
  },
  {
    key: 'solutions',
    name: 'Solutions Consultants / Engineers',
    description: 'Paid only when the deal signs, so incremental like an AE. Capitalize. (A salary or a bonus on non-deal goals would be expensed.)',
    treatment: 'capitalize',
    methodKey: null,
    match: /\b(se|sc|solution|sales engineer|pre-?sales)/i,
  },
  {
    key: 'sdr',
    name: 'SDR / BDR',
    description: 'Usually paid for meetings or pipeline, which happen whether or not a contract is signed: not incremental, so expensed as incurred.',
    treatment: 'expense',
    methodKey: 'immediate',
    match: /\b(sdr|bdr|lead|development rep|prospect)/i,
  },
  {
    key: 'leadership',
    name: 'Sales Managers & Leadership',
    description: 'Overrides tied to specific contracts are incremental: capitalize. Discretionary or team-wide bonuses not tied to contracts should be expensed.',
    treatment: 'capitalize',
    methodKey: null,
    match: /\b(manager|director|vp|head|leader|cro|rvp|avp)/i,
  },
  {
    key: 'renewals',
    name: 'Account Management / Renewals',
    description: 'Renewal and expansion commissions amortize over the renewal or expansion term.',
    treatment: 'capitalize',
    methodKey: 'contract_term',
    match: /\b(am|account manag|renewal|customer success|csm|expansion)/i,
  },
];

/** Suggest a built-in type key for an employee type's name (null when nothing fits). */
export function suggestTypeKey(employeeTypeName: string): string | null {
  // SDR first so "Business Development Rep" doesn't land on AE via "rep".
  const order = ['sdr', 'solutions', 'leadership', 'renewals', 'account_executive'];
  for (const key of order) {
    if (BUILTIN_TYPES.find((t) => t.key === key)!.match.test(employeeTypeName)) return key;
  }
  return null;
}

/** Problems with a method definition, or [] when it is usable. */
export function validateMethod(def: AmortizationMethodDef): string[] {
  const errs: string[] = [];
  const sum = (a: number[]) => Math.round(a.reduce((x, y) => x + y, 0) * 1000) / 1000;
  if (def.kind === 'straight_line') {
    if (def.periodBasis === 'fixed_months' && !(def.months && def.months >= 1)) errs.push('Enter the number of months.');
    if (def.periodBasis === 'contract_term' && !(def.termMultiplier > 0)) errs.push('The term multiplier must be more than zero.');
  }
  if (def.kind === 'yearly_percent') {
    if (!def.yearPercents.length) errs.push('Add at least one year.');
    if (def.yearPercents.some((p) => p < 0)) errs.push('Percentages cannot be negative.');
    if (sum(def.yearPercents) !== 100) errs.push(`Yearly percentages add up to ${sum(def.yearPercents)}%, not 100%.`);
  }
  if (def.kind === 'monthly_percent') {
    if (!def.monthPercents.length) errs.push('Add at least one month.');
    if (def.monthPercents.some((p) => p < 0)) errs.push('Percentages cannot be negative.');
    if (sum(def.monthPercents) !== 100) errs.push(`Monthly percentages add up to ${sum(def.monthPercents)}%, not 100%.`);
  }
  return errs;
}

/** Spread `amount` by weights, rounding cumulatively so cents never drift and the total is exact. */
export function spreadByWeights(amount: number, startMonth: string, weights: number[]): Record<string, number> {
  const out: Record<string, number> = {};
  const total = weights.reduce((a, b) => a + b, 0);
  if (!total) return { [startMonth]: roundCents(amount) };
  let cum = 0;
  let booked = 0;
  weights.forEach((w, i) => {
    cum += w;
    const target = i === weights.length - 1 ? roundCents(amount) : roundCents((amount * cum) / total);
    out[addMonths(startMonth, i)] = roundCents(target - booked);
    booked = target;
  });
  return out;
}

export interface ScheduleContext {
  payMonth: string;
  /** YYYY-MM-DD */
  contractStart: string | null;
  termMonths: number | null;
  defaultTermMonths: number;
}

export interface MethodSchedule {
  /** false when the method (or the practical expedient) expenses the amount. */
  capitalize: boolean;
  startMonth: string;
  months: number;
  byMonth: Record<string, number>;
  warnings: string[];
}

function startMonthFor(def: AmortizationMethodDef, ctx: ScheduleContext, warnings: string[]): string {
  if (def.startBasis === 'pay_month') return ctx.payMonth;
  if (def.startBasis === 'month_after_pay') return addMonths(ctx.payMonth, 1);
  if (!ctx.contractStart) {
    warnings.push('no_start');
    return ctx.payMonth;
  }
  return ctx.contractStart.slice(0, 7);
}

/** The schedule one method gives one amount. */
export function scheduleFor(amount: number, def: AmortizationMethodDef, ctx: ScheduleContext, practicalExpedient = false): MethodSchedule {
  const warnings: string[] = [];
  if (def.kind === 'immediate') return { capitalize: false, startMonth: ctx.payMonth, months: 0, byMonth: {}, warnings };
  const startMonth = startMonthFor(def, ctx, warnings);
  const term = () => {
    if (ctx.termMonths === null || !(ctx.termMonths > 0)) {
      warnings.push('no_term');
      return ctx.defaultTermMonths;
    }
    return ctx.termMonths;
  };
  let byMonth: Record<string, number>;
  let months: number;
  if (def.kind === 'straight_line') {
    months = Math.max(1, Math.round(def.periodBasis === 'fixed_months' ? (def.months ?? 1) : term() * (def.termMultiplier || 1)));
    byMonth = straightLine(amount, startMonth, months);
  } else if (def.kind === 'yearly_percent') {
    const weights = def.yearPercents.flatMap((p) => Array<number>(12).fill(p / 12));
    months = weights.length;
    byMonth = spreadByWeights(amount, startMonth, weights);
  } else {
    months = def.monthPercents.length;
    byMonth = spreadByWeights(amount, startMonth, def.monthPercents);
  }
  if (practicalExpedient && months <= 12) return { capitalize: false, startMonth: ctx.payMonth, months: 0, byMonth: {}, warnings: [...warnings, 'expedient'] };
  return { capitalize: true, startMonth, months, byMonth, warnings };
}

// -- Register ---------------------------------------------------------------

export interface RegisterAsset {
  id: string;
  /** Stable across reruns: deal|payee|role|tier|payout. Books each commission once. */
  sourceKey: string;
  runId: string | null;
  lineId: number | null;
  dealKey: string | null;
  payee: string;
  department: string;
  typeName: string;
  methodName: string;
  amount: number;
  /** YYYY-MM the commission was earned for payroll (pay month). */
  capitalizedMonth: string;
  /** YYYY-MM the month it entered the register (its period's close). */
  bookedMonth: string;
  startMonth: string;
  endMonth: string;
  months: number;
  byMonth: Record<string, number>;
  amortizationAccount: GlAccount | null;
  /** YYYY-MM the remaining balance was written off (churn, termination), if any. */
  writtenOffMonth: string | null;
  writeOffReason: string | null;
}

export type AssetStatus = 'not_started' | 'amortizing' | 'fully_amortized' | 'written_off';

export interface AssetPosition {
  /** Cumulative amortization recognized through the month (excluding write-off). */
  amortizedToDate: number;
  impaired: number;
  remaining: number;
  /** Recognized this month: ordinary amortization (incl. catch-up) and write-off. */
  amortizationThisMonth: number;
  impairmentThisMonth: number;
  /** Part of the remaining balance that amortizes in the next 12 months. */
  current: number;
  noncurrent: number;
  status: AssetStatus;
}

const cumThrough = (a: RegisterAsset, month: string) => roundCents(Object.entries(a.byMonth).reduce((s, [m, v]) => (m <= month ? s + v : s), 0));

/** Where an asset stands at the end of `month`. Assets booked after `month` are all zero. */
export function assetPosition(a: RegisterAsset, month: string): AssetPosition {
  const zero: AssetPosition = { amortizedToDate: 0, impaired: 0, remaining: 0, amortizationThisMonth: 0, impairmentThisMonth: 0, current: 0, noncurrent: 0, status: 'not_started' };
  if (a.bookedMonth > month) return zero;
  const prev = addMonths(month, -1);
  const w = a.writtenOffMonth;
  // Ordinary amortization stops the month before a write-off.
  const ordinaryThrough = (m: string) => (w && w <= m ? cumThrough(a, addMonths(w, -1)) : cumThrough(a, m));
  const amortizedToDate = ordinaryThrough(month);
  const before = a.bookedMonth === month ? 0 : ordinaryThrough(prev);
  const impaired = w && w <= month ? roundCents(a.amount - amortizedToDate) : 0;
  const impairmentThisMonth = w === month ? impaired : 0;
  const remaining = roundCents(a.amount - amortizedToDate - impaired);
  let current = 0;
  if (remaining !== 0) {
    for (let i = 1; i <= 12; i++) current += a.byMonth[addMonths(month, i)] ?? 0;
    current = roundCents(current);
    // Anything scheduled before now that is still on the books (not possible after catch-up) stays current.
    if (Math.abs(current) > Math.abs(remaining)) current = remaining;
  }
  const status: AssetStatus = w && w <= month ? 'written_off' : remaining === 0 ? 'fully_amortized' : a.startMonth > month ? 'not_started' : 'amortizing';
  return {
    amortizedToDate,
    impaired,
    remaining,
    amortizationThisMonth: roundCents(amortizedToDate - before),
    impairmentThisMonth,
    current,
    noncurrent: roundCents(remaining - current),
    status,
  };
}

export interface RollforwardMonth {
  month: string;
  opening: number;
  additions: number;
  amortization: number;
  impairment: number;
  closing: number;
  current: number;
  noncurrent: number;
}

export function registerRollforward(assets: RegisterAsset[], month: string): RollforwardMonth {
  const prev = addMonths(month, -1);
  let opening = 0;
  let additions = 0;
  let amortization = 0;
  let impairment = 0;
  let current = 0;
  let closing = 0;
  for (const a of assets) {
    if (a.bookedMonth > month) continue;
    const p = assetPosition(a, month);
    if (a.bookedMonth < month) opening += assetPosition(a, prev).remaining;
    else additions += a.amount;
    amortization += p.amortizationThisMonth;
    impairment += p.impairmentThisMonth;
    current += p.current;
    closing += p.remaining;
  }
  closing = roundCents(closing);
  current = roundCents(current);
  return {
    month,
    opening: roundCents(opening),
    additions: roundCents(additions),
    amortization: roundCents(amortization),
    impairment: roundCents(impairment),
    closing,
    current,
    noncurrent: roundCents(closing - current),
  };
}

// -- Monthly close ----------------------------------------------------------

export interface CloseLineInput {
  sourceKey: string;
  runId: string | null;
  lineId: number;
  dealKey: string | null;
  payee: string;
  role: string;
  /** Employee type name, or "Unassigned". */
  department: string;
  /** The employee type's amortization type, if mapped. */
  amortizationTypeId: string | null;
  /** The employee type's own treatment, used when no amortization type is mapped. */
  fallbackTreatment: CostTreatment;
  payout: number | null;
  status: string;
  payMonth: string | null;
  contractStart: string | null;
  termMonths: number | null;
}

export interface CloseInput {
  month: string;
  lines: CloseLineInput[];
  /** The register before this close. */
  assets: RegisterAsset[];
  /** sourceKeys already booked by earlier closes (capitalized and expensed). */
  bookedKeys: Set<string>;
  /** First month the register covers; lines paying earlier are out of scope. */
  registerStart: string;
  /** Current portion booked at the end of the previous month (0 when none). */
  priorCurrent: number;
  settings: AccountingSettings;
  methods: NamedMethod[];
  types: AmortizationTypeDef[];
}

export interface BookedLine {
  sourceKey: string;
  runId: string | null;
  lineId: number;
  dealKey: string | null;
  payee: string;
  department: string;
  typeName: string;
  methodName: string;
  treatment: CostTreatment;
  amount: number;
  payMonth: string;
  /** Paid in an earlier, already-closed month and booked now. */
  late: boolean;
  /** Why it was expensed rather than capitalized, when it was. */
  note: string | null;
}

export interface ReclassResult {
  /** Current portion the balance sheet should show at month end. */
  target: number;
  priorCurrent: number;
  /** Current-account balance before the reclass (true_up). */
  beforeReclass: number;
  /** Net amount moved from non-current to current (negative = the other way). */
  netMove: number;
}

export interface CloseResult {
  month: string;
  booked: BookedLine[];
  newAssets: RegisterAsset[];
  rollforward: RollforwardMonth;
  reclass: ReclassResult | null;
  entries: JournalEntry[];
  excluded: { sourceKey: string; lineId: number; payee: string; reason: string }[];
  warnings: string[];
  totals: { capitalized: number; expensed: number; amortization: number; impairment: number; accrued: number };
}

export function resolveLine(
  l: Pick<CloseLineInput, 'amortizationTypeId' | 'fallbackTreatment'>,
  settings: AccountingSettings,
  methods: NamedMethod[],
  types: AmortizationTypeDef[],
): { type: AmortizationTypeDef | null; treatment: CostTreatment; method: NamedMethod | null } {
  const type = l.amortizationTypeId ? (types.find((t) => t.id === l.amortizationTypeId) ?? null) : null;
  const treatment = type ? type.treatment : l.fallbackTreatment;
  const methodId = type?.methodId ?? settings.defaultMethodId;
  const method = methods.find((m) => m.id === methodId) ?? methods.find((m) => m.def.kind === 'straight_line') ?? null;
  return { type, treatment, method };
}

const acct = (a: GlAccount, department: string | null, debit: number, credit: number): JournalLine => ({
  account: a.name,
  accountNumber: a.number,
  department,
  debit: roundCents(debit),
  credit: roundCents(credit),
});

/** Sum amounts into lines keyed by account + department, sorted for stable output. */
function grouped(items: { account: GlAccount; department: string | null; amount: number }[], side: 'debit' | 'credit'): JournalLine[] {
  const map = new Map<string, { account: GlAccount; department: string | null; amount: number }>();
  for (const it of items) {
    const k = `${it.account.number}\u0001${it.account.name}\u0001${it.department ?? ''}`;
    const cur = map.get(k) ?? { account: it.account, department: it.department, amount: 0 };
    cur.amount = roundCents(cur.amount + it.amount);
    map.set(k, cur);
  }
  return [...map.values()]
    .filter((g) => g.amount !== 0)
    .sort((a, b) => a.account.number.localeCompare(b.account.number) || (a.department ?? '').localeCompare(b.department ?? ''))
    .map((g) => {
      // A negative debit (e.g. a clawback) is a credit, and vice versa.
      const pos = g.amount > 0;
      return side === 'debit' === pos ? acct(g.account, g.department, Math.abs(g.amount), 0) : acct(g.account, g.department, 0, Math.abs(g.amount));
    });
}

export function entryBalance(e: JournalEntry): { debit: number; credit: number; balanced: boolean } {
  const debit = roundCents(e.lines.reduce((a, l) => a + l.debit, 0));
  const credit = roundCents(e.lines.reduce((a, l) => a + l.credit, 0));
  return { debit, credit, balanced: debit === credit };
}

/** Everything one month's close books, without touching the register passed in. */
export function closeMonth(input: CloseInput): CloseResult {
  const { month, settings, methods, types } = input;
  const A = settings.accounts;
  const warnings = new Set<string>();
  const excluded: CloseResult['excluded'] = [];
  const booked: BookedLine[] = [];
  const newAssets: RegisterAsset[] = [];
  const seen = new Set<string>();
  let dupes = 0;

  for (const l of input.lines) {
    if (input.bookedKeys.has(l.sourceKey)) continue;
    if (l.status === 'hold') continue;
    if (l.payout === null || l.payout === 0 || !l.payMonth) continue;
    if (l.payMonth > month) continue;
    if (l.payMonth < input.registerStart) {
      excluded.push({ sourceKey: l.sourceKey, lineId: l.lineId, payee: l.payee, reason: `Pays in ${l.payMonth}, before the register starts (${input.registerStart})` });
      continue;
    }
    if (seen.has(l.sourceKey)) {
      dupes++;
      continue;
    }
    seen.add(l.sourceKey);

    const { type, treatment, method } = resolveLine(l, settings, methods, types);
    const late = l.payMonth < month;
    const base = {
      sourceKey: l.sourceKey,
      runId: l.runId,
      lineId: l.lineId,
      dealKey: l.dealKey,
      payee: l.payee,
      department: l.department,
      typeName: type?.name ?? (l.amortizationTypeId ? 'Missing type' : 'No amortization type'),
      amount: l.payout,
      payMonth: l.payMonth,
      late,
    };
    if (!type) warnings.add('Some payees have no amortization type; their employee type\'s own treatment and the default method were used.');
    if (treatment === 'expense' || !method) {
      booked.push({ ...base, methodName: '—', treatment: 'expense', note: treatment === 'expense' ? 'Type is expensed' : 'No amortization method' });
      continue;
    }
    const sched = scheduleFor(l.payout, method.def, { payMonth: l.payMonth, contractStart: l.contractStart, termMonths: l.termMonths, defaultTermMonths: settings.defaultTermMonths }, settings.practicalExpedient);
    if (sched.warnings.includes('no_start')) warnings.add('Some capitalized lines have no subscription start; amortization starts in their pay month.');
    if (sched.warnings.includes('no_term')) warnings.add(`Some capitalized lines have no contract term; the default of ${settings.defaultTermMonths} months was used.`);
    if (!sched.capitalize) {
      booked.push({ ...base, methodName: method.name, treatment: 'expense', note: sched.warnings.includes('expedient') ? 'Practical expedient: period is 12 months or less' : 'Method expenses immediately' });
      continue;
    }
    booked.push({ ...base, methodName: method.name, treatment: 'capitalize', note: null });
    newAssets.push({
      id: `new:${l.sourceKey}`,
      sourceKey: l.sourceKey,
      runId: l.runId,
      lineId: l.lineId,
      dealKey: l.dealKey,
      payee: l.payee,
      department: l.department,
      typeName: base.typeName,
      methodName: method.name,
      amount: l.payout,
      capitalizedMonth: l.payMonth,
      bookedMonth: month,
      startMonth: sched.startMonth,
      endMonth: addMonths(sched.startMonth, sched.months - 1),
      months: sched.months,
      byMonth: sched.byMonth,
      amortizationAccount: type?.amortizationAccount ?? null,
      writtenOffMonth: null,
      writeOffReason: null,
    });
    if (sched.startMonth < month) warnings.add('Some new assets started amortizing before this month; the catch-up is in this month\'s amortization.');
  }
  if (dupes) warnings.add(`${dupes} line${dupes === 1 ? ' appears' : 's appear'} in more than one run; each was booked once.`);
  const lateCount = booked.filter((b) => b.late).length;
  if (lateCount) warnings.add(`${lateCount} line${lateCount === 1 ? '' : 's'} paid in an earlier closed month ${lateCount === 1 ? 'was' : 'were'} booked now as late additions.`);
  if (booked.some((b) => b.amount < 0)) warnings.add('Some lines are negative (clawbacks or reversals); they reduce the balance and expense.');

  const typeById = new Map(types.map((t) => [t.name, t]));
  const all = [...input.assets.filter((a) => a.bookedMonth <= month), ...newAssets];
  const rollforward = registerRollforward(all, month);
  const positions = all.map((a) => ({ a, p: assetPosition(a, month) }));

  const deferredCredit = settings.reclassEnabled && settings.reclassMode === 'true_up' ? A.deferredCurrent : A.deferredNoncurrent;
  const entries: JournalEntry[] = [];

  // 1. Accrual: capitalized to the asset, expensed to commission expense, all owed to payees.
  if (booked.length) {
    const debits = grouped(
      booked.map((b) => ({
        account: b.treatment === 'capitalize' ? A.deferredNoncurrent : (typeById.get(b.typeName)?.expenseAccount ?? A.commissionExpense),
        department: b.department,
        amount: b.amount,
      })),
      'debit',
    );
    const credits = grouped([{ account: A.accruedCommissions, department: null, amount: booked.reduce((s, b) => s + b.amount, 0) }], 'credit');
    entries.push({ month, kind: 'accrual', memo: `Accrue commissions approved for ${month} payroll${lateCount ? ' (incl. late lines)' : ''}`, lines: [...debits, ...credits] });
  }

  // 2. Amortization of the register for the month.
  const amort = positions.filter((x) => x.p.amortizationThisMonth !== 0);
  if (amort.length) {
    const debits = grouped(
      amort.map(({ a, p }) => ({ account: a.amortizationAccount ?? A.amortizationExpense, department: a.department, amount: p.amortizationThisMonth })),
      'debit',
    );
    const credits = grouped([{ account: deferredCredit, department: null, amount: rollforward.amortization }], 'credit');
    entries.push({ month, kind: 'amortization', memo: `Amortization of deferred commissions for ${month}`, lines: [...debits, ...credits] });
  }

  // 3. Write-offs (impairment) of assets whose customer churned or contract ended early.
  const imp = positions.filter((x) => x.p.impairmentThisMonth !== 0);
  if (imp.length) {
    const debits = grouped(imp.map(({ a, p }) => ({ account: A.impairmentExpense, department: a.department, amount: p.impairmentThisMonth })), 'debit');
    const credits = grouped([{ account: deferredCredit, department: null, amount: rollforward.impairment }], 'credit');
    entries.push({ month, kind: 'impairment', memo: `Write-off of deferred commissions for ${month}`, lines: [...debits, ...credits] });
  }

  // 4. Reclass between current and non-current.
  let reclass: ReclassResult | null = null;
  if (settings.reclassEnabled) {
    const target = rollforward.current;
    const prior = roundCents(input.priorCurrent);
    if (settings.reclassMode === 'true_up') {
      const beforeReclass = roundCents(prior - rollforward.amortization - rollforward.impairment);
      const netMove = roundCents(target - beforeReclass);
      reclass = { target, priorCurrent: prior, beforeReclass, netMove };
      if (netMove !== 0) {
        const lines = netMove > 0 ? [acct(A.deferredCurrent, null, netMove, 0), acct(A.deferredNoncurrent, null, 0, netMove)] : [acct(A.deferredNoncurrent, null, -netMove, 0), acct(A.deferredCurrent, null, 0, -netMove)];
        entries.push({ month, kind: 'reclass', memo: `Reclass deferred commissions amortizing in the next 12 months to current`, lines });
      }
    } else {
      reclass = { target, priorCurrent: prior, beforeReclass: 0, netMove: roundCents(target - prior) };
      if (prior !== 0)
        entries.push({ month, kind: 'reclass', memo: `Reverse prior month's current reclass`, lines: [acct(A.deferredNoncurrent, null, prior, 0), acct(A.deferredCurrent, null, 0, prior)] });
      if (target !== 0)
        entries.push({ month, kind: 'reclass', memo: `Reclass deferred commissions amortizing in the next 12 months to current`, lines: [acct(A.deferredCurrent, null, target, 0), acct(A.deferredNoncurrent, null, 0, target)] });
    }
  }

  for (const e of entries) if (!entryBalance(e).balanced) warnings.add(`Entry "${e.memo}" does not balance.`);

  const capitalized = roundCents(booked.filter((b) => b.treatment === 'capitalize').reduce((s, b) => s + b.amount, 0));
  const expensed = roundCents(booked.filter((b) => b.treatment === 'expense').reduce((s, b) => s + b.amount, 0));
  return {
    month,
    booked,
    newAssets,
    rollforward,
    reclass,
    entries,
    excluded,
    warnings: [...warnings],
    totals: { capitalized, expensed, amortization: rollforward.amortization, impairment: rollforward.impairment, accrued: roundCents(capitalized + expensed) },
  };
}

/** Stable identity of a commission line across reruns of the same deals. */
export function lineSourceKey(l: { dealKey: string | null; rowIndex: number; payee: string; role: string; tierFrom: number | null; payout: number | null }): string {
  return [l.dealKey ?? `row${l.rowIndex}`, l.payee.trim().toLowerCase(), l.role.trim().toLowerCase(), l.tierFrom ?? '', l.payout ?? ''].join('|');
}
