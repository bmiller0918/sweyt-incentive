import { describe, expect, it } from 'vitest';
import { periodFromCriteria } from './calc.js';
import { parseDate } from './coerce.js';
import { emptyTemplateDefinition, employedOn, templateDeals, templateFields, templateProblems, type PayrollEmployee, type TemplateApplyInput } from './payroll.js';
import type { RawRow, TypedRow } from './types.js';

/** Rows as [owner, sdr, close date, amount, deal id]. */
function data(rows: [string, string, string, number, string][]) {
  const raw: RawRow[] = rows.map(([Owner, SDR, Close, Amount, Deal]) => ({ Owner, SDR, Close, Amount: String(Amount), Deal }));
  const typed: TypedRow[] = rows.map(([Owner, SDR, Close, Amount, Deal]) => ({ Owner, SDR, Close: Close ? parseDate(Close) : null, Amount, Deal }));
  return { raw, typed, indices: rows.map((_, i) => i) };
}

const rows = data([
  ['Ana AE', 'Sam SDR', '2026-03-02', 100, 'D-1'],
  ['Bo AE', '', '2026-03-10', 200, 'D-2'],
  ['Cy SE', 'Sam SDR', '2026-04-01', 300, 'D-3'],
  ['Ana AE', '', '', 50, 'D-4'],
]);

const staff: PayrollEmployee[] = [
  { name: 'Ana AE', employeeTypeId: 'ae', startDate: null, status: 'active', statusDate: null },
  { name: 'Bo AE', employeeTypeId: 'ae', startDate: null, status: 'active', statusDate: null },
  { name: 'Sam SDR', employeeTypeId: 'sdr', startDate: null, status: 'active', statusDate: null },
  { name: 'Cy SE', employeeTypeId: 'se', startDate: null, status: 'active', statusDate: null },
  { name: 'Di SE', employeeTypeId: 'se', startDate: '2026-03-15', status: 'active', statusDate: null },
  { name: 'Ed SE', employeeTypeId: 'se', startDate: null, status: 'terminated', statusDate: '2026-03-05' },
];

const tpl = (over: Partial<TemplateApplyInput['definition']>, employeeTypeId: string | null, role: string): TemplateApplyInput => ({
  name: `${role} template`,
  employeeTypeId,
  role,
  definition: { ...emptyTemplateDefinition(), amountField: 'Amount', dateField: 'Close', dealKeyField: 'Deal', ...over },
});

const open = { from: null, to: null, asOf: '2026-12-31' };

describe('templateDeals', () => {
  it('credits an AE on the deals they closed and skips people of another type', () => {
    const res = templateDeals(rows, tpl({ crediting: 'own', creditField: 'Owner' }, 'ae', 'AE'), staff, open);
    expect(res.deals.map((d) => [d.dealKey, d.payees.map((p) => p.name)])).toEqual([
      ['D-1', ['Ana AE']],
      ['D-2', ['Bo AE']],
      ['D-4', ['Ana AE']],
    ]);
    expect(res.deals[0].payees[0].role).toBe('AE');
    expect(res.warnings[0]).toMatch(/another employee type \(Cy SE\)/);
  });

  it('credits an SDR on the deals naming them and ignores blank cells', () => {
    const res = templateDeals(rows, tpl({ crediting: 'own', creditField: 'SDR' }, 'sdr', 'SDR'), staff, open);
    expect(res.deals.map((d) => d.dealKey)).toEqual(['D-1', 'D-3']);
  });

  it('pays every SE employed on the close date on every deal', () => {
    const res = templateDeals(rows, tpl({ crediting: 'all' }, 'se', 'SE'), staff, open);
    const by = Object.fromEntries(res.deals.map((d) => [d.dealKey, d.payees.map((p) => p.name)]));
    expect(by['D-1']).toEqual(['Cy SE', 'Ed SE']); // Di not started; Ed leaves on 3/5
    expect(by['D-2']).toEqual(['Cy SE']);
    expect(by['D-3']).toEqual(['Cy SE', 'Di SE']);
    expect(by['D-4']).toEqual(['Cy SE', 'Di SE']); // undated: as of the run's end
  });

  it('drops rows outside the window, and undated rows when bounded', () => {
    const res = templateDeals(rows, tpl({ crediting: 'own', creditField: 'Owner' }, null, 'Rep'), staff, { from: '2026-03-01', to: '2026-03-31', asOf: '2026-03-31' });
    expect(res.deals.map((d) => d.dealKey)).toEqual(['D-1', 'D-2']);
  });

  it('only reads the rows it is given', () => {
    const res = templateDeals({ ...rows, indices: [1] }, tpl({ crediting: 'own', creditField: 'Owner' }, 'ae', 'AE'), staff, open);
    expect(res.deals.map((d) => d.dealKey)).toEqual(['D-2']);
  });

  it('warns when nobody has the type of an all-deals template', () => {
    const res = templateDeals(rows, tpl({ crediting: 'all' }, 'sc', 'SC'), staff, open);
    expect(res.deals).toEqual([]);
    expect(res.warnings[0]).toMatch(/no employees/);
  });
});

describe('template helpers', () => {
  it('lists problems and fields', () => {
    expect(templateProblems(emptyTemplateDefinition(), null)).toHaveLength(2);
    expect(templateProblems({ ...emptyTemplateDefinition(), crediting: 'all', amountField: 'Amount' }, null)).toEqual(['Crediting all deals needs an employee type.']);
    expect(templateFields({ ...emptyTemplateDefinition(), crediting: 'all', creditField: 'Owner', amountField: 'Amount' })).toEqual(['Amount']);
  });

  it('employedOn respects start and termination dates', () => {
    expect(employedOn(staff[4], '2026-03-14')).toBe(false);
    expect(employedOn(staff[4], '2026-03-15')).toBe(true);
    expect(employedOn(staff[5], '2026-03-05')).toBe(false);
    expect(employedOn({ ...staff[5], statusDate: null }, '2026-01-01')).toBe(false);
  });
});

describe('periodFromCriteria', () => {
  const crit = (operator: string, values: unknown[]) => ({ root: { children: [{ type: 'condition', id: 'period:Close', field: 'Close', operator, values }] } }) as never;
  it('reads a custom range and a relative preset', () => {
    expect(periodFromCriteria(crit('between', [{ kind: 'literal', value: '2026-01-01' }, { kind: 'literal', value: '2026-03-31' }]), {})).toEqual({ from: '2026-01-01', to: '2026-03-31' });
    expect(periodFromCriteria(crit('relative', [{ kind: 'relative', preset: 'this_month' }]), {}, Date.UTC(2026, 9, 13))).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(periodFromCriteria({ root: { children: [] } } as never, {})).toBeNull();
  });
});
