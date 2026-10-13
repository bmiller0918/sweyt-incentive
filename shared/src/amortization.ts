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
import { ACCOUNTS, addMonths, monthsBetween, straightLine, type CostTreatment, type JournalEntry, type JournalLine } from './accounting.js';
import { compileFormula, FormulaError } from './formula.js';
import { roundCents } from './lines.js';

export type MethodKind = 'straight_line' | 'yearly_percent' | 'monthly_percent' | 'formula' | 'immediate';
/** straight_line and formula: what sets the number of months. */
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
  /** formula: the amount for each month, e.g. `NB / RT`. See FORMULA_VARIABLES. */
  formula?: string | null;
}

/** Variables a formula method can use, with what each one means. */
export const FORMULA_VARIABLES: { name: string; label: string }[] = [
  { name: 'CV', label: 'Capitalized value: the amount being amortized' },
  { name: 'NB', label: 'Net balance: what is left to amortize at the start of the month' },
  { name: 'AD', label: 'Amortized to date: CV − NB' },
  { name: 'T', label: 'Total months in the schedule' },
  { name: 'CP', label: 'Current period: 1 in the first month, 2 in the second, …' },
  { name: 'RT', label: 'Remaining months, counting this one (T − CP + 1)' },
  { name: 'LD', label: 'Last amount: what was amortized in the previous month (0 in the first)' },
  { name: 'Y', label: 'Year of the schedule: 1 for months 1–12, 2 for 13–24, …' },
  { name: 'MY', label: 'Month of that year: 1 to 12' },
  { name: 'TERM', label: 'Contract term in months (before any multiplier)' },
];
const FORMULA_NAMES = FORMULA_VARIABLES.map((v) => v.name);

/** Problems with a method formula, or null when it parses and only uses known variables. */
export function formulaProblem(src: string | null | undefined): string | null {
  try {
    compileFormula(src ?? '', FORMULA_NAMES);
    return null;
  } catch (e) {
    return e instanceof FormulaError || e instanceof Error ? e.message : String(e);
  }
}

/**
 * Spread `amount` over `months` with a formula evaluated month by month.
 * Each month is clamped to what is left (never negative), and the last
 * month takes whatever remains so the schedule always totals the amount.
 */
export function spreadByFormula(src: string, amount: number, startMonth: string, months: number, term: number): Record<string, number> {
  const f = compileFormula(src, FORMULA_NAMES);
  const out: Record<string, number> = {};
  const cv = roundCents(amount);
  let nb = cv;
  let ld = 0;
  for (let cp = 1; cp <= months; cp++) {
    let v: number;
    if (cp === months) v = nb;
    else {
      const r = f.evaluate({ CV: cv, NB: nb, AD: roundCents(cv - nb), T: months, CP: cp, RT: months - cp + 1, LD: ld, Y: Math.ceil(cp / 12), MY: ((cp - 1) % 12) + 1, TERM: term });
      // null (e.g. division by zero) is an error, not zero: it would silently push everything to the last month.
      const n = typeof r === 'number' ? r : typeof r === 'boolean' ? Number(r) : r === null || r === '' ? NaN : Number(r);
      if (!Number.isFinite(n)) throw Object.assign(new Error(`The formula "${src}" gave no number in month ${cp} of ${months} (TERM ${term}). Fix the amortization method.`), { statusCode: 400 });
      v = roundCents(cv >= 0 ? Math.min(Math.max(n, 0), nb) : Math.max(Math.min(n, 0), nb));
    }
    out[addMonths(startMonth, cp - 1)] = v;
    nb = roundCents(nb - v);
    ld = v;
  }
  return out;
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
  /** Further per-type account overrides (deferred, write-off, accrued); unset keys use the company accounts. */
  accounts?: Partial<AccountMap> | null;
  /** Term used when a deal has none; the company default when null. */
  defaultTermMonths?: number | null;
}

/** The accounts a type books to: company accounts, overridden by the type's own. */
export function typeAccounts(type: Pick<AmortizationTypeDef, 'expenseAccount' | 'amortizationAccount' | 'accounts'> | null | undefined, A: AccountMap): AccountMap {
  if (!type) return A;
  const o = type.accounts ?? {};
  return {
    deferredCurrent: o.deferredCurrent ?? A.deferredCurrent,
    deferredNoncurrent: o.deferredNoncurrent ?? A.deferredNoncurrent,
    commissionExpense: type.expenseAccount ?? o.commissionExpense ?? A.commissionExpense,
    amortizationExpense: type.amortizationAccount ?? o.amortizationExpense ?? A.amortizationExpense,
    impairmentExpense: o.impairmentExpense ?? A.impairmentExpense,
    accruedCommissions: o.accruedCommissions ?? A.accruedCommissions,
  };
}

/** The balance-sheet and expense accounts an asset uses, fixed when it is booked. */
export type AssetAccounts = Partial<Pick<AccountMap, 'deferredCurrent' | 'deferredNoncurrent' | 'impairmentExpense'>>;

/** A type's overrides that an asset keeps for its life (unset keys follow the company accounts). */
export function assetAccountsFor(type: Pick<AmortizationTypeDef, 'accounts'> | null | undefined): AssetAccounts | null {
  const o = type?.accounts;
  if (!o) return null;
  const out: AssetAccounts = {};
  if (o.deferredCurrent) out.deferredCurrent = o.deferredCurrent;
  if (o.deferredNoncurrent) out.deferredNoncurrent = o.deferredNoncurrent;
  if (o.impairmentExpense) out.impairmentExpense = o.impairmentExpense;
  return Object.keys(out).length ? out : null;
}

/** An asset's account for a role: its own override, else the company account. */
export function assetAccount(a: Pick<RegisterAsset, 'accounts' | 'amortizationAccount'>, key: 'deferredCurrent' | 'deferredNoncurrent' | 'impairmentExpense' | 'amortizationExpense', A: AccountMap): GlAccount {
  if (key === 'amortizationExpense') return a.amortizationAccount ?? A.amortizationExpense;
  return a.accounts?.[key] ?? A[key];
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
  if (def.kind === 'straight_line' || def.kind === 'formula') {
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
  if (def.kind === 'formula') {
    const p = formulaProblem(def.formula);
    if (p) errs.push(`Formula: ${p}.`);
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
  if (def.kind === 'straight_line' || def.kind === 'formula') {
    const t = def.periodBasis === 'fixed_months' ? null : term();
    months = Math.max(1, Math.round(t === null ? (def.months ?? 1) : t * (def.termMultiplier || 1)));
    byMonth = def.kind === 'formula' ? spreadByFormula(def.formula ?? '', amount, startMonth, months, t ?? months) : straightLine(amount, startMonth, months);
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
  /** Stable across reruns: deal|payee|role|tier. A changed payout books only the difference. */
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
  /** 'manual' for amortizations entered by hand (not from a commission run). Defaults to 'commission'. */
  origin?: AssetOrigin;
  /**
   * An opening balance already on the books (e.g. migrated from a spreadsheet):
   * it enters the rollforward as opening balance and books no addition entry.
   */
  opening?: boolean;
  /** Credit side of a manual amortization's addition entry; accrued commissions when null. */
  offsetAccount?: GlAccount | null;
  /** Deferred and write-off accounts from its type, when the type overrides them. */
  accounts?: AssetAccounts | null;
}

export type AssetOrigin = 'commission' | 'manual';

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
    else if (a.opening) opening += a.amount;
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
  /** sourceKey -> total already booked by earlier closes (capitalized and expensed). */
  booked: Map<string, number>;
  /** First month the register covers; lines paying earlier are out of scope. */
  registerStart: string;
  /** Current portion booked at the end of the previous month (0 when none). */
  priorCurrent: number;
  /**
   * The same, by deferred account pair ("current|non-current" account
   * numbers). When absent, all of priorCurrent sits in the company accounts.
   */
  priorCurrentByAccount?: Record<string, number>;
  settings: AccountingSettings;
  methods: NamedMethod[];
  types: AmortizationTypeDef[];
  /**
   * Manual amortizations entered but not yet booked. Those whose capitalized
   * month is on or before this month enter the register with this close.
   */
  pending?: RegisterAsset[];
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
  /** A recalculated commission: `amount` is the change from what was booked before. */
  adjustment: boolean;
  /** Why it was expensed rather than capitalized, when it was. */
  note: string | null;
}

export interface ReclassResult {
  /** Current portion per deferred account pair ("current|non-current"), for next month's reclass. */
  byAccount?: Record<string, number>;
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
  totals: { capitalized: number; expensed: number; amortization: number; impairment: number; accrued: number; manual: number };
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
  const seen = new Map<string, number | null>();
  let dupes = 0;
  let conflicts = 0;

  // Lines come newest run first, so when two runs disagree the latest calculation wins.
  for (const l of input.lines) {
    if (l.status === 'hold' || !l.payMonth || l.payMonth > month) continue;
    if (seen.has(l.sourceKey)) {
      dupes++;
      if (seen.get(l.sourceKey) !== l.payout) conflicts++;
      continue;
    }
    seen.set(l.sourceKey, l.payout);
    const prior = input.booked.get(l.sourceKey);
    // Already booked: only a recalculated payout books anything, and only the difference.
    const amount = prior === undefined ? (l.payout ?? 0) : roundCents((l.payout ?? 0) - prior);
    if (amount === 0) continue;
    if (prior === undefined && l.payMonth < input.registerStart) {
      excluded.push({ sourceKey: l.sourceKey, lineId: l.lineId, payee: l.payee, reason: `Pays in ${l.payMonth}, before the register starts (${input.registerStart})` });
      continue;
    }
    const adjustment = prior !== undefined;

    const { type, treatment, method } = resolveLine(l, settings, methods, types);
    const late = l.payMonth < month || adjustment;
    const base = {
      sourceKey: l.sourceKey,
      runId: l.runId,
      lineId: l.lineId,
      dealKey: l.dealKey,
      payee: l.payee,
      department: l.department,
      typeName: type?.name ?? (l.amortizationTypeId ? 'Missing type' : 'No amortization type'),
      amount,
      payMonth: l.payMonth,
      late,
      adjustment,
    };
    if (!type) warnings.add('Some payees have no amortization type; their employee type\'s own treatment and the default method were used.');
    if (treatment === 'expense' || !method) {
      booked.push({ ...base, methodName: '—', treatment: 'expense', note: treatment === 'expense' ? 'Type is expensed' : 'No amortization method' });
      continue;
    }
    const defaultTerm = type?.defaultTermMonths ?? settings.defaultTermMonths;
    const sched = scheduleFor(amount, method.def, { payMonth: l.payMonth, contractStart: l.contractStart, termMonths: l.termMonths, defaultTermMonths: defaultTerm }, settings.practicalExpedient);
    if (sched.warnings.includes('no_start')) warnings.add('Some capitalized lines have no subscription start; amortization starts in their pay month.');
    if (sched.warnings.includes('no_term'))
      warnings.add(
        type?.defaultTermMonths
          ? `Some capitalized lines have no contract term; their type's default term (${type.name}: ${type.defaultTermMonths} months) was used.`
          : `Some capitalized lines have no contract term; the default of ${settings.defaultTermMonths} months was used.`,
      );
    if (!sched.capitalize) {
      booked.push({ ...base, methodName: method.name, treatment: 'expense', note: sched.warnings.includes('expedient') ? 'Practical expedient: period is 12 months or less' : 'Method expenses immediately' });
      continue;
    }
    booked.push({ ...base, methodName: method.name, treatment: 'capitalize', note: null });
    newAssets.push({
      id: `new:${l.sourceKey}${adjustment ? ':adj' : ''}`,
      sourceKey: l.sourceKey,
      runId: l.runId,
      lineId: l.lineId,
      dealKey: l.dealKey,
      payee: l.payee,
      department: l.department,
      typeName: base.typeName,
      methodName: method.name,
      amount,
      capitalizedMonth: l.payMonth,
      bookedMonth: month,
      startMonth: sched.startMonth,
      endMonth: addMonths(sched.startMonth, sched.months - 1),
      months: sched.months,
      byMonth: sched.byMonth,
      amortizationAccount: type?.amortizationAccount ?? null,
      accounts: assetAccountsFor(type),
      writtenOffMonth: null,
      writeOffReason: null,
    });
    if (sched.startMonth < month) warnings.add('Some new assets started amortizing before this month; the catch-up is in this month\'s amortization.');
  }
  if (dupes) warnings.add(`${dupes} line${dupes === 1 ? ' appears' : 's appear'} in more than one run; each was booked once${conflicts ? `, using the newest run where payouts differ (${conflicts})` : ''}.`);
  const adjCount = booked.filter((b) => b.adjustment).length;
  if (adjCount) warnings.add(`${adjCount} commission${adjCount === 1 ? ' was' : 's were'} recalculated after booking; only the difference is booked now.`);
  const lateCount = booked.filter((b) => b.late && !b.adjustment).length;
  if (lateCount) warnings.add(`${lateCount} line${lateCount === 1 ? '' : 's'} paid in an earlier closed month ${lateCount === 1 ? 'was' : 'were'} booked now as late additions.`);
  if (booked.some((b) => b.amount < 0)) warnings.add('Some lines are negative (clawbacks or reversals); they reduce the balance and expense.');

  // Manual amortizations due by this month enter the register now, keeping their own ids.
  const manual = (input.pending ?? []).filter((p) => p.capitalizedMonth <= month).map((p) => ({ ...p, origin: 'manual' as const, bookedMonth: month }));
  for (const m of manual) if (m.startMonth < month && !m.opening) warnings.add('Some manual amortizations started before this month; the catch-up is in this month\'s amortization.');
  newAssets.push(...manual);

  const typeByName = new Map(types.map((t) => [t.name, t]));
  const all = [...input.assets.filter((a) => a.bookedMonth <= month), ...newAssets];
  const rollforward = registerRollforward(all, month);
  const positions = all.map((a) => ({ a, p: assetPosition(a, month) }));

  // Amortization and write-offs reduce current when the reclass trues up each month, else non-current.
  const creditKey = settings.reclassEnabled && settings.reclassMode === 'true_up' ? 'deferredCurrent' : 'deferredNoncurrent';
  const entries: JournalEntry[] = [];

  // 1. Accrual: capitalized to the asset, expensed to commission expense, all owed to payees (each by its type's accounts).
  if (booked.length) {
    const accts = (b: BookedLine) => typeAccounts(typeByName.get(b.typeName), A);
    const debits = grouped(
      booked.map((b) => ({
        account: b.treatment === 'capitalize' ? accts(b).deferredNoncurrent : accts(b).commissionExpense,
        department: b.department,
        amount: b.amount,
      })),
      'debit',
    );
    const credits = grouped(
      booked.map((b) => ({ account: accts(b).accruedCommissions, department: null, amount: b.amount })),
      'credit',
    );
    entries.push({ month, kind: 'accrual', memo: `Accrue commissions approved for ${month} payroll${lateCount ? ' (incl. late lines)' : ''}`, lines: [...debits, ...credits] });
  }

  // 1b. Manual amortizations: the asset against the account each one names. Opening balances are already on the books.
  const added = manual.filter((m) => !m.opening && m.amount !== 0);
  if (added.length) {
    const debits = grouped(added.map((m) => ({ account: assetAccount(m, 'deferredNoncurrent', A), department: m.department, amount: m.amount })), 'debit');
    const credits = grouped(added.map((m) => ({ account: m.offsetAccount ?? A.accruedCommissions, department: null, amount: m.amount })), 'credit');
    entries.push({ month, kind: 'addition', memo: `Capitalize manual amortizations for ${month}`, lines: [...debits, ...credits] });
  }

  // 2. Amortization of the register for the month.
  const amort = positions.filter((x) => x.p.amortizationThisMonth !== 0);
  if (amort.length) {
    const debits = grouped(
      amort.map(({ a, p }) => ({ account: assetAccount(a, 'amortizationExpense', A), department: a.department, amount: p.amortizationThisMonth })),
      'debit',
    );
    const credits = grouped(amort.map(({ a, p }) => ({ account: assetAccount(a, creditKey, A), department: null, amount: p.amortizationThisMonth })), 'credit');
    entries.push({ month, kind: 'amortization', memo: `Amortization of deferred commissions for ${month}`, lines: [...debits, ...credits] });
  }

  // 3. Write-offs (impairment) of assets whose customer churned or contract ended early.
  const imp = positions.filter((x) => x.p.impairmentThisMonth !== 0);
  if (imp.length) {
    const debits = grouped(imp.map(({ a, p }) => ({ account: assetAccount(a, 'impairmentExpense', A), department: a.department, amount: p.impairmentThisMonth })), 'debit');
    const credits = grouped(imp.map(({ a, p }) => ({ account: assetAccount(a, creditKey, A), department: null, amount: p.impairmentThisMonth })), 'credit');
    entries.push({ month, kind: 'impairment', memo: `Write-off of deferred commissions for ${month}`, lines: [...debits, ...credits] });
  }

  // 4. Reclass between current and non-current, per pair of deferred accounts.
  let reclass: ReclassResult | null = null;
  if (settings.reclassEnabled) {
    const pairKey = (cur: GlAccount, nc: GlAccount) => `${cur.number}|${nc.number}`;
    const pairs = new Map<string, { cur: GlAccount; nc: GlAccount; target: number; reduced: number }>();
    const pairOf = (cur: GlAccount, nc: GlAccount) => {
      const k = pairKey(cur, nc);
      if (!pairs.has(k)) pairs.set(k, { cur, nc, target: 0, reduced: 0 });
      return pairs.get(k)!;
    };
    pairOf(A.deferredCurrent, A.deferredNoncurrent);
    for (const { a, p } of positions) {
      const pr = pairOf(assetAccount(a, 'deferredCurrent', A), assetAccount(a, 'deferredNoncurrent', A));
      pr.target += p.current;
      pr.reduced += p.amortizationThisMonth + p.impairmentThisMonth;
    }
    // Last month's current portion by pair; older closes kept one total, all in the company accounts.
    const priorBy: Record<string, number> = input.priorCurrentByAccount ?? { [pairKey(A.deferredCurrent, A.deferredNoncurrent)]: input.priorCurrent };
    for (const k of Object.keys(priorBy)) {
      if (!pairs.has(k) && priorBy[k]) {
        const [curNo, ncNo] = k.split('|');
        pairOf({ number: curNo, name: A.deferredCurrent.number === curNo ? A.deferredCurrent.name : 'Deferred commissions, current' }, { number: ncNo, name: A.deferredNoncurrent.number === ncNo ? A.deferredNoncurrent.name : 'Deferred commissions, non-current' });
      }
    }
    const byAccount: Record<string, number> = {};
    let totPrior = 0;
    let totBefore = 0;
    let totMove = 0;
    const many = [...pairs.values()].filter((x) => roundCents(x.target) || priorBy[pairKey(x.cur, x.nc)]).length > 1;
    for (const [k, pr] of pairs) {
      const target = roundCents(pr.target);
      const prior = roundCents(priorBy[k] ?? 0);
      if (target || prior) byAccount[k] = target;
      totPrior += prior;
      const suffix = many ? ` (${pr.cur.number} / ${pr.nc.number})` : '';
      if (settings.reclassMode === 'true_up') {
        const before = roundCents(prior - (creditKey === 'deferredCurrent' ? pr.reduced : 0));
        const netMove = roundCents(target - before);
        totBefore += before;
        totMove += netMove;
        if (netMove !== 0) {
          const lines = netMove > 0 ? [acct(pr.cur, null, netMove, 0), acct(pr.nc, null, 0, netMove)] : [acct(pr.nc, null, -netMove, 0), acct(pr.cur, null, 0, -netMove)];
          entries.push({ month, kind: 'reclass', memo: `Reclass deferred commissions amortizing in the next 12 months to current${suffix}`, lines });
        }
      } else {
        totMove += target - prior;
        if (prior !== 0) entries.push({ month, kind: 'reclass', memo: `Reverse prior month's current reclass${suffix}`, lines: [acct(pr.nc, null, prior, 0), acct(pr.cur, null, 0, prior)] });
        if (target !== 0)
          entries.push({ month, kind: 'reclass', memo: `Reclass deferred commissions amortizing in the next 12 months to current${suffix}`, lines: [acct(pr.cur, null, target, 0), acct(pr.nc, null, 0, target)] });
      }
    }
    reclass = {
      target: rollforward.current,
      priorCurrent: roundCents(totPrior),
      beforeReclass: settings.reclassMode === 'true_up' ? roundCents(totBefore) : 0,
      netMove: roundCents(totMove),
      byAccount,
    };
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
    totals: {
      capitalized,
      expensed,
      amortization: rollforward.amortization,
      impairment: rollforward.impairment,
      accrued: roundCents(capitalized + expensed),
      manual: roundCents(manual.reduce((s, m) => s + m.amount, 0)),
    },
  };
}

/**
 * Stable identity of a commission line across reruns of the same deals:
 * deal, payee, role and tier band, but not the payout, so a recalculation
 * is recognized and only its difference booked. Deals without a key fall
 * back to their row number, which is only stable while the import is.
 */
export function lineSourceKey(l: { dealKey: string | null; rowIndex: number; payee: string; role: string; tierFrom: number | null }): string {
  return [l.dealKey ?? `row${l.rowIndex}`, l.payee.trim().toLowerCase(), l.role.trim().toLowerCase(), l.tierFrom ?? ''].join('|');
}

/** Total booked per sourceKey across closed months' booked lines. */
export function bookedTotals(lines: { sourceKey: string; amount: number }[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const b of lines) m.set(b.sourceKey, roundCents((m.get(b.sourceKey) ?? 0) + b.amount));
  return m;
}

// -- Manual amortizations, modifications and reporting -----------------------

/** Straight-line over the term from the start month: the default for a manual amortization. */
export const STRAIGHT_LINE: AmortizationMethodDef = { kind: 'straight_line', periodBasis: 'contract_term', months: null, termMultiplier: 1, yearPercents: [], monthPercents: [], startBasis: 'contract_start' };

/** Months from `from` to `to`, inclusive (0 when `to` is before `from`). */
export function monthCount(from: string, to: string): number {
  return Math.max(0, monthsBetween(from, to) + 1);
}

export interface ManualScheduleInput {
  amount: number;
  /** YYYY-MM the amortization starts. */
  startMonth: string;
  /** Term in months; a fixed-period method (e.g. a 48-month customer life) uses its own. */
  months: number;
  /** Shape of the curve; straight-line when omitted. */
  def?: AmortizationMethodDef | null;
}

/**
 * The schedule of an amortization entered by hand. It always starts in the
 * month given; a method only shapes the curve (and, for a fixed period, its length).
 */
export function manualSchedule(input: ManualScheduleInput): { startMonth: string; endMonth: string; months: number; byMonth: Record<string, number> } {
  const def = { ...(input.def ?? STRAIGHT_LINE), startBasis: 'contract_start' as const };
  if (def.kind === 'immediate') throw new Error('That method expenses immediately, so there is nothing to amortize. Pick another method.');
  if (!(input.months >= 1)) throw new Error('The term must be at least one month.');
  const errs = validateMethod(def);
  if (errs.length) throw new Error(errs[0]);
  const sched = scheduleFor(input.amount, def, { payMonth: input.startMonth, contractStart: `${input.startMonth}-01`, termMonths: Math.round(input.months), defaultTermMonths: Math.round(input.months) });
  return { startMonth: sched.startMonth, endMonth: addMonths(sched.startMonth, sched.months - 1), months: sched.months, byMonth: sched.byMonth };
}

/**
 * Change an asset's schedule from `fromMonth` on (a change in estimate,
 * applied prospectively). Months before `fromMonth` are closed and stay
 * as booked; what is left is spread evenly from `fromMonth` (or the new
 * start, if the asset has not started) through the new end month.
 */
export function rescheduleAsset(
  a: Pick<RegisterAsset, 'amount' | 'startMonth' | 'endMonth' | 'byMonth'>,
  fromMonth: string,
  change: { startMonth?: string; endMonth: string },
): { startMonth: string; endMonth: string; months: number; byMonth: Record<string, number> } {
  const kept: Record<string, number> = {};
  for (const [m, v] of Object.entries(a.byMonth)) if (m < fromMonth) kept[m] = v;
  const started = Object.keys(kept).length > 0;
  if (started && change.startMonth && change.startMonth !== a.startMonth) throw new Error('The start can only change before amortization has been booked.');
  const startMonth = started ? a.startMonth : (change.startMonth ?? a.startMonth);
  if (!started && startMonth < fromMonth) throw new Error(`The start must be ${fromMonth} or later; earlier months are closed.`);
  const spreadFrom = started ? fromMonth : startMonth;
  if (change.endMonth < spreadFrom) throw new Error(`The end must be ${spreadFrom} or later.`);
  const remaining = roundCents(a.amount - Object.values(kept).reduce((s, v) => s + v, 0));
  const byMonth = { ...kept, ...straightLine(remaining, spreadFrom, monthCount(spreadFrom, change.endMonth)) };
  return { startMonth, endMonth: change.endMonth, months: monthCount(startMonth, change.endMonth), byMonth };
}

export interface RangeRollforward {
  initial: number;
  additions: number;
  amortization: number;
  writeOffs: number;
  ending: number;
}

/**
 * Rollforward of a set of assets over a range of months (e.g. a fiscal
 * year): initial balance + additions − amortization − write-offs = ending.
 * Opening balances entered in the range count as initial balance.
 */
export function rollforwardRange(a: RegisterAsset, from: string, to: string): RangeRollforward {
  const zero = { initial: 0, additions: 0, amortization: 0, writeOffs: 0, ending: 0 };
  if (a.bookedMonth > to) return zero;
  const end = assetPosition(a, to);
  const before = a.bookedMonth < from ? assetPosition(a, addMonths(from, -1)) : null;
  const initial = before ? before.remaining : a.opening ? a.amount : 0;
  return {
    initial,
    additions: before || a.opening ? 0 : a.amount,
    amortization: roundCents(end.amortizedToDate - (before?.amortizedToDate ?? 0)),
    writeOffs: roundCents(end.impaired - (before?.impaired ?? 0)),
    ending: end.remaining,
  };
}

/**
 * Amortization still to come after `month`, by month: the waterfall of
 * today's balance. Nothing after a write-off; an asset not booked by
 * `month` contributes nothing.
 */
export function futureAmortization(a: RegisterAsset, month: string): Record<string, number> {
  const out: Record<string, number> = {};
  if (a.bookedMonth > month || (a.writtenOffMonth && a.writtenOffMonth <= month)) return out;
  for (const [m, v] of Object.entries(a.byMonth)) if (m > month && !(a.writtenOffMonth && m >= a.writtenOffMonth) && v !== 0) out[m] = v;
  return out;
}

export interface AssetModification {
  at: string;
  by: string;
  /** created, modified, transferred, written_off, write_off_undone, booked, unbooked */
  action: string;
  /** First month the change affects (YYYY-MM), when it is a schedule change. */
  effectiveMonth: string | null;
  changes: { field: string; from: string | number | null; to: string | number | null }[];
  note: string | null;
}
