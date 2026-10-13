// Commission payroll templates: how one employee type is credited on the
// deals in an import. A template is applied to whatever data was dumped in
// (filtered on the Commission Payroll screen) and turns each row into deals
// for the line engine (lines.ts).
//
// Crediting decides who is paid on a row:
// - 'own': the person named in one column (an AE on the deals they closed, an
//   SDR on the deals they sourced, an SE named on the deal).
// - 'all': every employee of the template's type, on every deal (an SE or SC
//   pool paid across all the deals, not just the ones naming them).
// Each payee then gets one line per deal under their own plan, as before.
import { z } from 'zod';
import { formatDateMs } from './coerce.js';
import { holdRuleSchema } from './holds.js';
import { componentKey } from './components.js';
import type { DealInput, DealPayee } from './lines.js';
import type { RawRow, TypedRow } from './types.js';

export const CREDITING = ['own', 'all'] as const;
export type Crediting = (typeof CREDITING)[number];

export const CREDITING_LABELS: Record<Crediting, string> = {
  own: 'Their own deals',
  all: 'All deals',
};

export const CREDITING_HINTS: Record<Crediting, string> = {
  own: 'Each deal pays the person named in the credit column, e.g. an AE on the deals they closed or an SDR on the deals they sourced.',
  all: 'Every active employee of this type is paid on every deal in the data, e.g. an SE or SC team that supports all deals.',
};

/** The column mapping and rules a template carries. '' = not mapped. */
export const payrollTemplateDefinitionSchema = z.object({
  crediting: z.enum(CREDITING).default('own'),
  /** 'own' only: the column naming the person credited. */
  creditField: z.string().default(''),
  amountField: z.string().default(''),
  dateField: z.string().default(''),
  dealKeyField: z.string().default(''),
  contractStartField: z.string().default(''),
  termMonthsField: z.string().default(''),
  contractEndField: z.string().default(''),
  marginField: z.string().default(''),
  /** Weighted-plan components → the column holding each one's value. */
  components: z.array(z.object({ name: z.string().min(1), field: z.string().min(1) })).default([]),
  /** Deals matching a rule start on hold with that rule's reason (after the workspace payout rules). */
  holdRules: z.array(holdRuleSchema).default([]),
});
export type PayrollTemplateDefinition = z.infer<typeof payrollTemplateDefinitionSchema>;

export function emptyTemplateDefinition(): PayrollTemplateDefinition {
  return payrollTemplateDefinitionSchema.parse({});
}

/** Every column a template reads, for checking an import has them. */
export function templateFields(d: PayrollTemplateDefinition): string[] {
  return [
    d.crediting === 'own' ? d.creditField : '',
    d.amountField,
    d.dateField,
    d.dealKeyField,
    d.contractStartField,
    d.termMonthsField,
    d.contractEndField,
    d.marginField,
    ...d.components.map((c) => c.field),
    ...d.holdRules.map((r) => r.condition.field),
  ].filter((f) => !!f);
}

/** What a template still needs before it can run. Empty = ready. */
export function templateProblems(d: PayrollTemplateDefinition, employeeTypeId: string | null): string[] {
  const out: string[] = [];
  if (d.crediting === 'own' && !d.creditField) out.push('Pick the column that names the person credited.');
  if (d.crediting === 'all' && !employeeTypeId) out.push('Crediting all deals needs an employee type.');
  if (!d.amountField) out.push('Pick the amount column.');
  return out;
}

/** An employee as templates see them: for type checks and "all deals" eligibility. */
export interface PayrollEmployee {
  name: string;
  employeeTypeId: string | null;
  startDate: string | null;
  status: string;
  statusDate: string | null;
}

/** Employed on the date: started by then, and not terminated or inactive before it. Leave still counts. */
export function employedOn(e: PayrollEmployee, date: string): boolean {
  if (e.startDate && e.startDate > date) return false;
  if (e.status === 'terminated' || e.status === 'inactive') return !!e.statusDate && date < e.statusDate;
  return true;
}

/** Whole months between two ISO dates, rounded (a 3-year term is 36 even if the end is the 31st). */
export function monthsBetweenDates(start: string, end: string): number {
  const [sy, sm, sd] = start.split('-').map(Number);
  const [ey, em, ed] = end.split('-').map(Number);
  const months = ey * 12 + em - (sy * 12 + sm);
  return Math.max(1, Math.round(months + (ed - sd) / 30));
}

export interface TemplateApplyInput {
  name: string;
  employeeTypeId: string | null;
  /** The role on each line; usually the employee type's name. */
  role: string;
  definition: PayrollTemplateDefinition;
}

export interface TemplateDeals {
  deals: DealInput[];
  /** Row index → subscription start and term, for amortization. */
  contract: Map<number, { start: string | null; term: number | null }>;
  warnings: string[];
}

/**
 * Turn the chosen rows of an import into deals for one template. `indices`
 * are the rows already through the screen's filters; rows outside
 * [from, to] on the template's date column are dropped (undated rows too,
 * when either bound is set).
 */
export function templateDeals(
  data: { raw: RawRow[]; typed: TypedRow[]; indices: number[] },
  t: TemplateApplyInput,
  employees: PayrollEmployee[],
  window: { from: string | null; to: string | null; asOf: string },
): TemplateDeals {
  const d = t.definition;
  const isoOf = (field: string, row: TypedRow) => {
    const v = field ? row[field] : null;
    return typeof v === 'number' ? formatDateMs(v, 'date') : null;
  };
  const byName = new Map(employees.map((e) => [e.name.trim().toLowerCase(), e]));
  const pool = t.employeeTypeId ? employees.filter((e) => e.employeeTypeId === t.employeeTypeId) : [];
  const measureFields = new Map<string, string>();
  for (const c of d.components) {
    const key = componentKey(c.name);
    if (key && !measureFields.has(key)) measureFields.set(key, c.field);
  }

  const deals: DealInput[] = [];
  const contract = new Map<number, { start: string | null; term: number | null }>();
  const otherType = new Set<string>();
  let noPool = 0;
  for (const i of data.indices) {
    const row = data.typed[i];
    const rawRow = data.raw[i];
    const date = isoOf(d.dateField, row);
    if (window.from && date !== null && date < window.from) continue;
    if (window.to && date !== null && date > window.to) continue;
    if ((window.from || window.to) && date === null) continue;

    let payees: DealPayee[];
    if (d.crediting === 'all') {
      const on = date ?? window.asOf;
      payees = pool.filter((e) => employedOn(e, on)).map((e) => ({ role: t.role, name: e.name }));
      if (!payees.length) noPool++;
    } else {
      const name = String(rawRow[d.creditField] ?? '').trim();
      const known = byName.get(name.toLowerCase());
      // Someone set up under another employee type is paid by that type's template, not this one.
      if (known && t.employeeTypeId && known.employeeTypeId && known.employeeTypeId !== t.employeeTypeId) {
        otherType.add(known.name);
        continue;
      }
      payees = name ? [{ role: t.role, name }] : [];
    }
    if (!payees.length) continue;

    const start = isoOf(d.contractStartField, row);
    const termRaw = d.termMonthsField ? row[d.termMonthsField] : null;
    const end = isoOf(d.contractEndField, row);
    const term = typeof termRaw === 'number' && termRaw > 0 ? termRaw : start && end && end > start ? monthsBetweenDates(start, end) : null;
    contract.set(i, { start, term });
    const measures: Record<string, number | null> = {};
    for (const [k, field] of measureFields) {
      const v = row[field];
      measures[k] = typeof v === 'number' ? v : null;
    }
    const amount = row[d.amountField];
    const marginRaw = d.marginField ? row[d.marginField] : undefined;
    deals.push({
      rowIndex: i,
      dealKey: d.dealKeyField ? String(rawRow[d.dealKeyField] ?? '').trim() || null : null,
      date,
      amount: typeof amount === 'number' ? amount : null,
      payees,
      measures,
      ...(d.marginField ? { margin: typeof marginRaw === 'number' ? marginRaw : null } : {}),
    });
  }

  const warnings: string[] = [];
  if (otherType.size) {
    const names = [...otherType].slice(0, 5).join(', ');
    warnings.push(`${t.name}: skipped deals credited to ${otherType.size} ${otherType.size === 1 ? 'person' : 'people'} of another employee type (${names}${otherType.size > 5 ? '…' : ''}).`);
  }
  if (d.crediting === 'all' && t.employeeTypeId && !pool.length) warnings.push(`${t.name}: no employees have this template's employee type, so it paid nothing.`);
  else if (noPool) warnings.push(`${t.name}: ${noPool} deal${noPool === 1 ? '' : 's'} had no one of this type employed on the close date.`);
  return { deals, contract, warnings };
}
